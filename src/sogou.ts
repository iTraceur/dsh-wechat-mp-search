/**
 * 搜狗微信搜索业务逻辑:会话级 cookie jar、请求间限速抖动、
 * 反爬命中后重建会话重试、真实链接还原与正文抓取。
 * @module dsh-wechat-mp-search/sogou
 */

import { fetchOnce, jarToHeader, updateJar } from './http.js'
import { absolutizeLink, extractArticleText, extractRealUrl, extractSearchResults, isAntiSpider } from './parse.js'
import type { ResolvedConfig, SearchPageResult, SearchRow } from './types.js'

/** 与原 Python MCP 保持一致的浏览器 User-Agent。 */
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0'

const SEARCH_URL = 'https://weixin.sogou.com/weixin'
const ARTICLE_URL_PREFIX = 'https://mp.weixin.qq.com/'
const MAX_SEARCH_ATTEMPTS = 2

/** {@link doArticle} 失败时返回文案的固定前缀,供入口层描述文案引用,避免多处硬编码漂移。 */
export const ARTICLE_FAILURE_PREFIX = '获取文章内容失败:'
/** `weixin_search` 的 `page` 参数默认值。 */
export const DEFAULT_PAGE = 1
/** `weixin_search_all` 的 `max_pages` 参数默认值(小于 `ResolvedConfig.maxPages` 硬上限)。 */
export const DEFAULT_MAX_PAGES = 10

/** 与 dsh 插件 `Config` 默认值一致的完整默认配置。 */
export const DEFAULT_CONFIG: ResolvedConfig = {
  requestTimeoutMs: 15_000,
  maxOutputBytes: 8_000_000,
  linkDelayMs: 200,
  linkDelayJitterMs: 400,
  pageDelayMs: 1000,
  pageDelayJitterMs: 1000,
  retryDelayMs: 2500,
  maxPages: 30,
}

/**
 * 数值配置钳制:非有限数(NaN/Infinity)或低于下界时回退默认值。
 * 覆盖不经 schemastery 校验、直接以 `Partial<ResolvedConfig>` 传入的调用方
 * (如 MCP 入口),保证运行时配置永远落在有效区间。
 * @param value - 调用方提供的原始值。
 * @param floor - 允许的最小值(含)。
 * @param fallback - 值非法时的回退默认值。
 * @returns 钳制后的有效值。
 */
function withFloor(value: number | undefined, floor: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor ? value : fallback
}

/**
 * 合并用户配置与默认值,并对每个数值字段做下界钳制,得到全部字段
 * 均有确定有效值的配置。dsh 入口与 MCP 入口共用,保证两个分发形态行为一致。
 * @param overrides - 调用方提供的可选配置覆盖。
 * @returns 所有字段均有确定值的配置。
 */
export function resolveConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    requestTimeoutMs: withFloor(overrides.requestTimeoutMs, 1, DEFAULT_CONFIG.requestTimeoutMs),
    maxOutputBytes: withFloor(overrides.maxOutputBytes, 0, DEFAULT_CONFIG.maxOutputBytes),
    linkDelayMs: withFloor(overrides.linkDelayMs, 0, DEFAULT_CONFIG.linkDelayMs),
    linkDelayJitterMs: withFloor(overrides.linkDelayJitterMs, 0, DEFAULT_CONFIG.linkDelayJitterMs),
    pageDelayMs: withFloor(overrides.pageDelayMs, 0, DEFAULT_CONFIG.pageDelayMs),
    pageDelayJitterMs: withFloor(overrides.pageDelayJitterMs, 0, DEFAULT_CONFIG.pageDelayJitterMs),
    retryDelayMs: withFloor(overrides.retryDelayMs, 0, DEFAULT_CONFIG.retryDelayMs),
    maxPages: withFloor(overrides.maxPages, 0, DEFAULT_CONFIG.maxPages),
  }
}

/**
 * 取出 signal 的 abort 原因;未自定义原因时构造标准 AbortError,
 * 供取消传播路径统一抛出。
 * @param signal - 已 abort 的信号。
 * @returns 取消原因(通常是 `DOMException` AbortError)。
 */
function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/**
 * 等待 `[minMs, maxMs)` 之间的一个随机时长,用于请求间限速抖动。
 * 等待期间收到取消信号则立即中断并抛出 AbortError。
 * @param minMs - 最小延迟(毫秒)。
 * @param maxMs - 最大延迟上限(毫秒),需不小于 `minMs`。
 * @param signal - 可选的取消信号。
 */
export async function jitterDelay(minMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  const span = Math.max(0, maxMs - minMs)
  const delay = minMs + (span > 0 ? Math.random() * span : 0)
  if (delay <= 0) return
  if (signal?.aborted) throw abortReasonOf(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReasonOf(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function searchHeaders(query: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: `https://weixin.sogou.com/weixin?query=${encodeURIComponent(query)}`,
  }
}

/** 跳转链接解析与文章正文抓取共用的请求头:固定 User-Agent,可变 Referer。 */
function articleHeaders(referer: string): Record<string, string> {
  return { 'User-Agent': USER_AGENT, Referer: referer }
}

/**
 * 还原一个搜狗跳转链接对应的微信公众号真实链接。
 * 复用调用方传入的会话 cookie jar;网络异常返回空串不向上抛出,
 * 外部取消信号触发时向上抛出 AbortError 交由框架按取消处理。
 * @param cfg - 已解析默认值的插件配置。
 * @param link - 已绝对化的搜狗跳转链接。
 * @param jar - 当前搜索会话的 cookie jar(会被更新)。
 * @param signal - 可选的取消信号。
 * @returns 还原后的真实链接,失败为空串。
 */
export async function resolveRealUrl(
  cfg: ResolvedConfig,
  link: string,
  jar: Map<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const res = await fetchOnce(link, {
      headers: articleHeaders('https://weixin.sogou.com/'),
      timeoutMs: cfg.requestTimeoutMs,
      maxBodyBytes: cfg.maxOutputBytes,
      signal,
      cookieHeader: jarToHeader(jar),
    })
    updateJar(jar, res.setCookies)
    if (res.status !== 200) return ''
    return extractRealUrl(res.body)
  } catch (error) {
    if (signal?.aborted) throw error
    return ''
  }
}

/**
 * 执行一次单页搜狗微信搜索,含四项反爬增强中的三项:
 * 会话 cookie jar(同一 attempt 内的搜索请求与链接解析请求共享)、
 * 链接解析之间的限速抖动、命中反爬后重建全新会话重试一次。
 * @param cfg - 已解析默认值的插件配置。
 * @param query - 搜索关键词。
 * @param page - 页码,从 1 开始。
 * @param signal - 可选的取消信号。
 * @returns 本页结果与是否命中反爬拦截。
 */
export async function doSearch(
  cfg: ResolvedConfig,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<SearchPageResult> {
  for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
    const jar = new Map<string, string>()
    let res
    try {
      res = await fetchOnce(SEARCH_URL, {
        headers: searchHeaders(query),
        params: {
          type: 2,
          s_from: 'input',
          query,
          ie: 'utf8',
          page,
          _sug_: 'n',
          _sug_type_: '',
        },
        timeoutMs: cfg.requestTimeoutMs,
        maxBodyBytes: cfg.maxOutputBytes,
        signal,
        cookieHeader: jarToHeader(jar),
      })
    } catch (error) {
      // 外部取消:向上传播,由框架按"工具被取消"处理,而非伪装成空结果。
      if (signal?.aborted) throw error
      // 网络异常按未拦截、空结果处理,不向上抛出。
      return { results: [], blocked: false }
    }
    updateJar(jar, res.setCookies)

    if (res.status !== 200) return { results: [], blocked: false }

    if (isAntiSpider(res.body, res.finalUrl)) {
      if (attempt < MAX_SEARCH_ATTEMPTS) {
        await jitterDelay(cfg.retryDelayMs, cfg.retryDelayMs + 1000, signal)
        continue
      }
      return { results: [], blocked: true }
    }

    const rows = extractSearchResults(res.body)
    const results: SearchRow[] = []
    for (const row of rows) {
      const link = absolutizeLink(row.link)
      // 非搜狗域的绝对链接视为不可信(防会话 cookie 外泄),整行丢弃。
      if (link === '') continue
      await jitterDelay(cfg.linkDelayMs, cfg.linkDelayMs + cfg.linkDelayJitterMs, signal)
      const real_url = await resolveRealUrl(cfg, link, jar, signal)
      results.push({ title: row.title, link, real_url, publish_time: row.publish_time, page: String(page) })
    }
    return { results, blocked: false }
  }
  return { results: [], blocked: true }
}

/**
 * 按 `weixin_search_all` 语义聚合多页搜索:请求页数被 `cfg.maxPages`
 * 硬钳制;页间执行限速抖动;空页(已无更多结果)或命中反爬立即停止。
 * 与原 Python MCP 的翻页终止条件保持一致。
 * @param cfg - 已解析默认值的插件配置。
 * @param query - 搜索关键词。
 * @param maxPages - 请求的最大翻页数(默认入口层取 10)。
 * @param signal - 可选的取消信号。
 * @returns 聚合结果与是否命中反爬拦截。
 */
export async function doSearchAll(
  cfg: ResolvedConfig,
  query: string,
  maxPages: number,
  signal?: AbortSignal,
): Promise<SearchPageResult> {
  const limit = Math.min(Math.max(0, Math.floor(maxPages)), cfg.maxPages)
  const results: SearchRow[] = []
  for (let page = 1; page <= limit; page++) {
    if (page > 1) await jitterDelay(cfg.pageDelayMs, cfg.pageDelayMs + cfg.pageDelayJitterMs, signal)
    const pageResult = await doSearch(cfg, query, page, signal)
    results.push(...pageResult.results)
    if (pageResult.blocked || pageResult.results.length === 0) {
      return { results, blocked: pageResult.blocked }
    }
  }
  return { results, blocked: false }
}

/**
 * 抓取微信公众号文章正文。任何失败都不抛异常,而是返回
 * `"获取文章内容失败: <原因>"` 形式的字符串;仅外部取消信号触发时
 * 向上抛出 AbortError,交由框架按取消处理。
 * @param cfg - 已解析默认值的插件配置。
 * @param realUrl - 微信公众号文章真实链接。
 * @param referer - 可选 Referer 请求头。
 * @param signal - 可选的取消信号。
 * @returns 正文纯文本,或失败提示字符串。
 */
export async function doArticle(
  cfg: ResolvedConfig,
  realUrl: string,
  referer: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!realUrl || !realUrl.startsWith(ARTICLE_URL_PREFIX)) {
    return `${ARTICLE_FAILURE_PREFIX} 未拿到有效的微信公众号文章链接`
  }
  try {
    const res = await fetchOnce(realUrl, {
      headers: articleHeaders(referer ?? 'https://mp.weixin.qq.com/'),
      timeoutMs: cfg.requestTimeoutMs,
      maxBodyBytes: cfg.maxOutputBytes,
      signal,
    })
    if (res.status !== 200) {
      return `${ARTICLE_FAILURE_PREFIX} HTTP 状态码 ${res.status}`
    }
    const text = extractArticleText(res.body)
    if (!text) {
      return `${ARTICLE_FAILURE_PREFIX} 未能解析到正文内容`
    }
    return text
  } catch (error) {
    if (signal?.aborted) throw error
    return `${ARTICLE_FAILURE_PREFIX} ${error instanceof Error ? error.message : String(error)}`
  }
}
