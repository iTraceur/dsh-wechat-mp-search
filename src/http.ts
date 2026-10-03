/**
 * 基于 Node 原生 fetch 的最小 HTTP 封装 + 会话 cookie jar 纯函数。
 * 不使用 `ctx.shell` + curl,避免 shell 转义注入风险;直接用
 * Node 20+ 全局 `fetch()`,`AbortSignal.any` 合并取消信号与超时。
 * @module dsh-wechat-mp-search/http
 */

/** {@link fetchOnce} 的请求选项。 */
export interface FetchOnceOptions {
  /** 附加请求头。 */
  headers?: Record<string, string>
  /** 整体替换 URL 查询串的参数(不保留 URL 自带的 query)。 */
  params?: Record<string, string | number>
  /** 单次请求超时(毫秒)。 */
  timeoutMs: number
  /** 响应体最大字节数;流式读取累计达到上限即停止下载并截断。 */
  maxBodyBytes?: number
  /** 外部取消信号(如工具调用取消),与超时信号合并。 */
  signal?: AbortSignal
  /** 会话 cookie jar 序列化后的 `Cookie` 请求头值。 */
  cookieHeader?: string
}

/** {@link fetchOnce} 的返回结果。 */
export interface FetchOnceResult {
  /** HTTP 状态码。 */
  status: number
  /** 跟随跳转后的最终 URL。 */
  finalUrl: string
  /** 响应体文本(可能已按 `maxBodyBytes` 截断)。 */
  body: string
  /** 本次响应携带的全部 `Set-Cookie` 值。 */
  setCookies: string[]
}

/**
 * 计算不产生“半个字符”尾巴的安全解码长度:仅当 `limit` 恰好切在某个
 * 多字节 UTF-8 字符中间时回退到该字符起点(UTF-8 单字符最长 4 字节,
 * 故最多回退 3 字节)。正文内部的非法字节不在此处处理,交由解码器
 * 按 U+FFFD 替换。
 * @param bytes - 原始字节。
 * @param limit - 期望的解码长度上限(需 > 0)。
 * @returns 可安全解码的长度。
 */
function safeUtf8Length(bytes: Uint8Array, limit: number): number {
  let start = limit - 1
  let back = 0
  while (start > 0 && (bytes[start] & 0xc0) === 0x80 && back < 3) {
    start--
    back++
  }
  const lead = bytes[start]
  const need = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0
  return need !== 0 && start + need > limit ? start : limit
}

/**
 * 按 UTF-8 字符边界截断字节序列并解码为字符串,避免在多字节字符中间
 * 切断产生乱码尾巴。解码使用非致命模式(`fatal: false`):正文中混入的
 * 个别非法字节会退化成 U+FFFD,但不会像致命模式那样让截断点之前的
 * 全部内容一起丢失。
 * @param bytes - 原始字节。
 * @param maxBytes - 最大字节数。
 * @returns 截断范围内的 UTF-8 文本。
 */
function decodeBytesTruncated(bytes: Uint8Array, maxBytes: number): string {
  const limit = Math.min(bytes.byteLength, maxBytes)
  if (limit <= 0) return ''
  return new TextDecoder('utf-8').decode(bytes.subarray(0, safeUtf8Length(bytes, limit)))
}

/**
 * 按字节数截断字符串,回退到最近的合法 UTF-8 字符边界。
 * @param text - 原始文本。
 * @param maxBytes - 最大字节数。
 * @returns 未超出则原样返回;否则返回按字符边界截断后的文本。
 */
function truncateUtf8(text: string, maxBytes: number): string {
  return decodeBytesTruncated(Buffer.from(text, 'utf8'), maxBytes)
}

/**
 * 读取响应体并限制最大字节数:优先经 `response.body` 流式读取,
 * 累计达到 `maxBytes` 即取消下载,避免超大响应先整体进入内存;
 * 无流式 body(如测试桩)时回退 `text()` 全量读取后截断。
 * @param response - fetch 响应。
 * @param maxBytes - 最大字节数。
 * @returns 按字符边界截断后的响应体文本。
 */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return truncateUtf8(await response.text(), maxBytes)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      chunks.push(value)
      received += value.byteLength
    }
  }
  if (received >= maxBytes) await reader.cancel().catch(() => {})
  return decodeBytesTruncated(Buffer.concat(chunks), maxBytes)
}

/** 允许携带会话 cookie 的 host 白名单。jar 不区分 domain/path,故在此统一收口。 */
const COOKIE_HOSTS: ReadonlySet<string> = new Set(['weixin.sogou.com'])
/** 单次请求最多跟随的跳转次数。 */
const MAX_REDIRECTS = 5

/** 是否需要跟随的跳转状态码。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 读取 `Set-Cookie`(运行时不支持 `getSetCookie` 时返回空数组)。 */
function readSetCookies(response: Response): string[] {
  return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
}

/** 目标 host 是否允许收发本插件的会话 cookie。 */
function isCookieHost(target: URL): boolean {
  return COOKIE_HOSTS.has(target.hostname.toLowerCase())
}

/** 一次请求(含跳转链)的最终响应与其间采集到的信息。 */
interface RedirectTrace {
  /** 最终响应;跳转次数超限或 Location 非法时为该 3xx 响应本身。 */
  response: Response
  /** 最终 URL。 */
  finalUrl: string
  /** 白名单 host 上采集到的全部 `Set-Cookie`。 */
  setCookies: string[]
}

/**
 * 手动跟随跳转发起请求。不使用 `redirect: 'follow'`,实测原因有两条:
 *
 * 1. `follow` 只暴露**最终**响应上的 `Set-Cookie`,中途各跳的 `Set-Cookie`
 *    会被丢弃;而最终响应可能来自跳转目标域(如 `mp.weixin.qq.com`,
 *    甚至被开放重定向带到的任意域)。{@link updateJar} 用的是扁平的
 *    name→value jar,不区分 domain/path,把第三方域下发的 cookie 收进去,
 *    之后就会被随搜狗域的请求一起发回——即跨域 cookie 注入。
 * 2. cookie 作用域因此只能依赖运行时对跨域跳转的隐式处理。Node 的 fetch
 *    确实会摘掉跨域跳转上的 `Cookie` 头(已在 Node 24 实测),但那是运行时
 *    的实现细节,不是本插件的显式保证。手动跟随可在每一跳重新判定 host,
 *    把"只给白名单 host 发 cookie、只收白名单 host 的 cookie"变成代码里
 *    可读、可测试的约束。
 *
 * 代价是跳转链有了明确上限 {@link MAX_REDIRECTS}。
 * @param target - 首个请求目标。
 * @param opts - 请求选项。
 * @param signal - 已合并超时与外部取消的信号;整个跳转链共用同一超时预算。
 * @returns 最终响应、最终 URL 与采集到的 `Set-Cookie`。
 */
async function fetchFollowingRedirects(
  target: URL,
  opts: FetchOnceOptions,
  signal: AbortSignal | undefined,
): Promise<RedirectTrace> {
  const setCookies: string[] = []
  let current = target
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = { ...opts.headers }
    if (opts.cookieHeader && isCookieHost(current)) headers.Cookie = opts.cookieHeader

    const response = await fetch(current, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    })

    // 只采集白名单 host 的 Set-Cookie:jar 不区分 domain,混入第三方域下发的
    // cookie 后,会被随后的搜狗域请求一起发回。
    if (isCookieHost(current)) setCookies.push(...readSetCookies(response))

    const location = isRedirectStatus(response.status) ? response.headers.get('location') : null
    if (location === null || location === '' || hop >= MAX_REDIRECTS) {
      const finalUrl = typeof response.url === 'string' && response.url !== '' ? response.url : current.href
      return { response, finalUrl, setCookies }
    }

    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      // Location 不是合法 URL:不再跟随,交由调用方按非 200 响应处理。
      return { response, finalUrl: current.href, setCookies }
    }
    // 释放跳转响应的连接后再继续。
    await response.body?.cancel().catch(() => {})
    current = next
  }
}

/**
 * 发起一次 GET 请求,跟随跳转(跨域跳转自动摘掉会话 cookie),合并取消信号
 * 与超时,必要时截断响应体。
 * @param url - 请求目标 URL。
 * @param opts - 请求选项。
 * @returns 状态码、最终 URL、响应体与 Set-Cookie 列表。
 */
export async function fetchOnce(url: string, opts: FetchOnceOptions): Promise<FetchOnceResult> {
  const target = new URL(url)
  if (opts.params) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(opts.params)) {
      search.set(key, String(value))
    }
    target.search = search.toString()
  }

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs)
  const signals = [timeoutSignal, opts.signal].filter((s): s is AbortSignal => s !== undefined)
  const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

  const { response, finalUrl, setCookies } = await fetchFollowingRedirects(target, opts, combinedSignal)

  const body = opts.maxBodyBytes === undefined
    ? await response.text()
    : await readBody(response, opts.maxBodyBytes)

  return {
    status: response.status,
    finalUrl,
    body,
    setCookies,
  }
}

/**
 * 将 cookie jar 序列化为可用于 `Cookie` 请求头的字符串。
 * @param jar - 会话内累积的 cookie 键值对。
 * @returns `key=value; key2=value2` 形式的字符串;空 jar 返回空串。
 */
export function jarToHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
}

/**
 * 判断 Set-Cookie 属性段是否指示立即删除该 cookie
 * (`Expires` 为过去时间,或 `Max-Age` 不大于 0)。
 * @param attrs - 首个 `key=value` 片段之后的属性片段列表。
 * @returns 是否为删除语义。
 */
function isDeletedCookie(attrs: readonly string[]): boolean {
  for (const attr of attrs) {
    const normalized = attr.trim().toLowerCase()
    if (normalized.startsWith('max-age=')) {
      const seconds = Number.parseInt(normalized.slice('max-age='.length).trim(), 10)
      if (Number.isInteger(seconds) && seconds <= 0) return true
    }
    if (normalized.startsWith('expires=')) {
      const expires = Date.parse(normalized.slice('expires='.length).trim())
      if (!Number.isNaN(expires) && expires <= Date.now()) return true
    }
  }
  return false
}

/**
 * 用一组 `Set-Cookie` 响应头更新 cookie jar(原地累积,同名覆盖;
 * 带删除语义的 Set-Cookie 移除对应键)。
 * @param jar - 会话内累积的 cookie 键值对(会被修改)。
 * @param setCookies - 待合并的 `Set-Cookie` 原始值列表。
 */
export function updateJar(jar: Map<string, string>, setCookies: readonly string[]): void {
  for (const raw of setCookies) {
    const parts = raw.split(';')
    const firstPair = parts[0] ?? ''
    const eqIdx = firstPair.indexOf('=')
    if (eqIdx <= 0) continue
    const key = firstPair.slice(0, eqIdx).trim()
    const value = firstPair.slice(eqIdx + 1).trim()
    if (!key) continue
    if (isDeletedCookie(parts.slice(1))) {
      jar.delete(key)
      continue
    }
    jar.set(key, value)
  }
}
