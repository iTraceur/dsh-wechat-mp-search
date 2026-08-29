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
 * 按 UTF-8 字符边界截断字节序列并解码为字符串,避免在多字节
 * 字符中间切断产生乱码尾巴(最多回退 3 字节,UTF-8 单字符最长 4 字节)。
 * @param bytes - 原始字节。
 * @param maxBytes - 最大字节数。
 * @returns 截断范围内的合法 UTF-8 文本;无法解码时返回空串。
 */
function decodeBytesTruncated(bytes: Uint8Array, maxBytes: number): string {
  const limit = Math.min(bytes.byteLength, maxBytes)
  if (limit <= 0) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = limit; end > 0 && end > limit - 4; end--) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      continue
    }
  }
  return ''
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

/**
 * 发起一次 GET 请求,跟随跳转,合并取消信号与超时,必要时截断响应体。
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

  const headers: Record<string, string> = { ...opts.headers }
  if (opts.cookieHeader) headers.Cookie = opts.cookieHeader

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs)
  const signals = [timeoutSignal, opts.signal].filter((s): s is AbortSignal => s !== undefined)
  const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

  const response = await fetch(target, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: combinedSignal,
  })

  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []

  const body = opts.maxBodyBytes === undefined
    ? await response.text()
    : await readBody(response, opts.maxBodyBytes)

  return {
    status: response.status,
    finalUrl: response.url,
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
