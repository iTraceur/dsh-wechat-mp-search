/**
 * 纯函数集合:HTML 实体解码、标签剥离、反爬检测、搜索结果解析、
 * 真实链接还原、正文提取。均不依赖网络或 dsh 运行时,便于单测覆盖。
 * @module dsh-wechat-mp-search/parse
 */

import type { RawSearchRow } from './types.js'

/** 命名 HTML 实体到字符的映射(小写键)。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  middot: '·',
  hellip: '…',
  ndash: '–',
}

/**
 * 解码 HTML 实体:命名实体(如 `&amp;`)与数字实体(十进制 `&#39;`、十六进制 `&#x27;`)。
 * @param input - 原始文本。
 * @returns 解码后的文本;未识别的命名实体原样保留。
 */
const ENTITY_RE = /&#x([0-9a-fA-F]+);|&#(\d+);|&([a-zA-Z]+);/g

/**
 * 将数字实体码点转为字符。畸形码点(超出 Unicode 上限、落在 UTF-16
 * 代理区)按 HTML5 规范替换为 U+FFFD,而非让 `String.fromCodePoint`
 * 抛出 RangeError 击穿解析层——页面 HTML 属不可信外部输入。
 * @param codePoint - 待转换的码点。
 * @returns 对应字符,或替换符 U+FFFD。
 */
function fromCodePointSafe(codePoint: number): string {
  const isValid = Number.isInteger(codePoint)
    && codePoint >= 0
    && codePoint <= 0x10FFFF
    && (codePoint < 0xD800 || codePoint > 0xDFFF)
  return isValid ? String.fromCodePoint(codePoint) : '�'
}

export function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (match: string, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined) return fromCodePointSafe(Number.parseInt(hex, 16))
    if (dec !== undefined) return fromCodePointSafe(Number.parseInt(dec, 10))
    const value = NAMED_ENTITIES[(name ?? '').toLowerCase()]
    return value ?? match
  })
}

/**
 * 剥离所有 HTML 标签,仅保留文本内容。
 * @param html - 含标签的字符串。
 * @returns 去标签后的原始文本(未做实体解码)。
 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/**
 * 判定响应是否命中搜狗/微信反爬拦截页。
 * 三个条件(小写匹配)任一命中即视为拦截:最终 URL 含 `antispider`;
 * 响应体含 `seccoderight`;响应体含 `anti.min.css`。
 * @param body - 响应体原文。
 * @param finalUrl - 跟随跳转后的最终 URL。
 * @returns 是否命中反爬拦截。
 */
export function isAntiSpider(body: string, finalUrl: string): boolean {
  return /antispider/i.test(finalUrl)
    || /seccoderight/i.test(body)
    || /anti\.min\.css/i.test(body)
}

const TITLE_ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
const TITLE_ID_RE = /id\s*=\s*"sogou_vr_11002601_title_\d+"/i
const HREF_RE = /href\s*=\s*"([^"]*)"/i
const TIME_SPAN_RE = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi
const CLASS_ATTR_RE = /class\s*=\s*"([^"]*)"/i

const TIME_CONVERT_RE = /timeConvert\('(\d+)'\)/

/**
 * 归一化发布时间文本。搜狗结果页的时间节点常以
 * `document.write(timeConvert('NNN'))` 形式内联 JS 时间戳,
 * 提取 unix 秒并按本地时区格式化为 `YYYY-MM-DD`;其余情况原样返回。
 * @param raw - 去标签后的时间节点文本。
 * @returns 可读的发布时间文本。
 */
function normalizePublishTime(raw: string): string {
  const ts = TIME_CONVERT_RE.exec(raw)?.[1]
  if (ts === undefined) return raw
  const date = new Date(Number(ts) * 1000)
  if (Number.isNaN(date.getTime())) return raw
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 从搜狗微信搜索结果页 HTML 中解析标题/链接与发布时间。
 * 标题节点特征:`id="sogou_vr_11002601_title_N"` 的 `<a>` 标签。
 * 时间节点特征:`class` 含 `s2` 的 `<span>` 标签,与标题按出现顺序一一配对。
 * @param html - 搜索结果页 HTML。
 * @returns 解析出的行,链接尚未绝对化。
 */
export function extractSearchResults(html: string): RawSearchRow[] {
  const titles: Array<{ link: string; title: string }> = []
  for (const match of html.matchAll(TITLE_ANCHOR_RE)) {
    const attrs = match[1] ?? ''
    if (!TITLE_ID_RE.test(attrs)) continue
    const href = HREF_RE.exec(attrs)?.[1] ?? ''
    const title = decodeEntities(stripTags(match[2] ?? '')).trim()
    titles.push({ link: href, title })
  }

  const times: string[] = []
  for (const match of html.matchAll(TIME_SPAN_RE)) {
    const attrs = match[1] ?? ''
    const classAttr = CLASS_ATTR_RE.exec(attrs)?.[1] ?? ''
    const classes = classAttr.split(/\s+/).filter(Boolean)
    if (!classes.includes('s2')) continue
    times.push(normalizePublishTime(decodeEntities(stripTags(match[2] ?? '')).trim()))
  }

  return titles.map((entry, index) => ({
    title: entry.title,
    link: entry.link,
    publish_time: times[index] ?? '',
  }))
}

/**
 * 将搜狗跳转链接绝对化:相对路径拼接 `https://weixin.sogou.com` 前缀;
 * 绝对链接仅当 host 恰为 `weixin.sogou.com` 时原样返回(含端口视为异域),
 * 其余(含非法 URL)返回空串,由调用方丢弃整行——防止搜索页被注入后
 * 携会话 cookie 请求第三方域名。
 * @param link - 原始 href。
 * @returns 可信的搜狗域绝对 URL;不可信时为空串。
 */
export function absolutizeLink(link: string): string {
  if (/^https?:\/\//i.test(link)) {
    try {
      if (new URL(link).host === 'weixin.sogou.com') return link
    } catch {
      // 非法 URL 落入空串分支,交由调用方丢弃。
    }
    return ''
  }
  return `https://weixin.sogou.com${link}`
}

const URL_FRAGMENT_MARKER = 'url += \''

/**
 * 从搜狗跳转页 HTML/JS 中还原微信公众号真实链接。
 * 扫描所有 `url += '...'` 片段(简单 indexOf 扫描,非正则/JS 引擎),
 * 依次拼接并去除其中所有 `@` 字符得到 full_url;
 * full_url 为空返回空串,否则返回 `https://mp.` + full_url。
 * @param html - 跳转页 HTML。
 * @returns 还原后的真实链接,或空串。
 */
export function extractRealUrl(html: string): string {
  let full = ''
  let cursor = 0
  while (true) {
    const start = html.indexOf(URL_FRAGMENT_MARKER, cursor)
    if (start < 0) break
    const contentStart = start + URL_FRAGMENT_MARKER.length
    const end = html.indexOf('\'', contentStart)
    if (end < 0) break
    full += html.slice(contentStart, end)
    cursor = end + 1
  }
  full = full.split('@').join('')
  if (full === '') return ''
  // 新版搜狗跳转页拼出的已是完整 URL(https://mp.weixin.qq.com/...),
  // 旧版为裸域名路径(weixin.qq.com/s?...),需补 https://mp. 前缀。
  if (/^https?:\/\//i.test(full)) return full
  return `https://mp.${full}`
}

/** 正文提取时视为块级结束的闭合标签,均在其后插入换行。 */
const BLOCK_CLOSE_TAGS_RE = /<\/(p|div|section|li|h[1-6]|blockquote|tr|ul|ol)>/gi
const BR_TAG_RE = /<br\s*\/?>/gi
const CONTENT_START_MARKER = 'id="js_content"'
const CONTENT_END_RE = /id="js_tags"|class="rich_media_tool"|id="js_pc_qr_code"|<script/

/**
 * 从微信公众号文章页 HTML 中提取正文纯文本。
 * 定位 `id="js_content"` 的容器,在块级闭合标签或 `<br>` 处换行,
 * 去除所有标签、解码 HTML 实体,按行 trim 并过滤空行。
 * @param html - 文章页 HTML。
 * @returns 正文纯文本;未找到正文容器时返回空串。
 */
export function extractArticleText(html: string): string {
  const startIdx = html.indexOf(CONTENT_START_MARKER)
  if (startIdx < 0) return ''
  const tagEnd = html.indexOf('>', startIdx)
  if (tagEnd < 0) return ''
  let content = html.slice(tagEnd + 1)

  const sentinelMatch = CONTENT_END_RE.exec(content)
  let cut = sentinelMatch ? sentinelMatch.index : content.length
  // 哨兵字符串本身多为标签内的属性片段(如 `id="js_tags"`),直接在该处截断
  // 会留下一个未闭合的开标签残片(如悬空的 `<div `)。回退到该标签的起始
  // `<`,把整个未完成的标签一并排除,避免正文尾部混入标签碎片。
  if (cut < content.length) {
    const tagStart = content.lastIndexOf('<', cut)
    if (tagStart >= 0) cut = tagStart
  }
  content = content.slice(0, cut)

  content = content.replace(BR_TAG_RE, '\n').replace(BLOCK_CLOSE_TAGS_RE, '\n')
  const text = decodeEntities(stripTags(content))
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  return lines.join('\n')
}
