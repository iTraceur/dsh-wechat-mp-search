import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchOnce, jarToHeader, updateJar } from '../src/http.ts'

interface MockResponseInit {
  status?: number
  url?: string
  body?: string
  setCookies?: string[]
  /** 可选的 `Location` 响应头(3xx 跳转用)。 */
  location?: string
  /** 可选的流式响应体;提供时走 `response.body` 流式读取路径。 */
  bodyStream?: ReadableStream<Uint8Array>
}

function mockResponse(opts: MockResponseInit = {}): Response {
  const base: Record<string, unknown> = {
    status: opts.status ?? 200,
    url: opts.url ?? 'https://example.com/',
    text: () => Promise.resolve(opts.body ?? ''),
    headers: {
      getSetCookie: () => opts.setCookies ?? [],
      get: (name: string) => (name.toLowerCase() === 'location' ? opts.location ?? null : null),
    },
  }
  if (opts.bodyStream !== undefined) base.body = opts.bodyStream
  return base as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchOnce maxBodyBytes 截断', () => {
  it('纯 ASCII 场景按字节数正常截断', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: 'a'.repeat(20) }))

    const res = await fetchOnce('https://example.com/', { timeoutMs: 5000, maxBodyBytes: 10 })

    expect(res.body).toBe('a'.repeat(10))
  })

  it('截断点落在多字节字符中间时回退到字符边界,不产生乱码', async () => {
    // "中" 为 3 字节;9 个 'a'(9 字节)+ "中" 共 12 字节,maxBodyBytes=10 会切在其中间。
    fetchMock.mockResolvedValueOnce(mockResponse({ body: `${'a'.repeat(9)}中` }))

    const res = await fetchOnce('https://example.com/', { timeoutMs: 5000, maxBodyBytes: 10 })

    expect(res.body).toBe('a'.repeat(9))
    expect(Buffer.byteLength(res.body, 'utf8')).toBeLessThanOrEqual(10)
  })

  it('未超出 maxBodyBytes 时原样返回', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '短文本' }))

    const res = await fetchOnce('https://example.com/', { timeoutMs: 5000, maxBodyBytes: 100 })

    expect(res.body).toBe('短文本')
  })

  it('流式 body:达到 maxBodyBytes 即取消下载,不读完整个响应', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'.repeat(50)))
        // 故意不 close:若未在达到上限后取消,读取将挂起导致测试超时。
      },
      cancel() {
        cancelled = true
      },
    })
    fetchMock.mockResolvedValueOnce(mockResponse({ bodyStream: stream }))

    const res = await fetchOnce('https://example.com/', { timeoutMs: 5000, maxBodyBytes: 10 })

    expect(res.body).toBe('a'.repeat(10))
    expect(cancelled).toBe(true)
  })

  it('流式 body:截断点落在多字节字符中间时回退到字符边界', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${'a'.repeat(9)}中中中`))
        controller.close()
      },
    })
    fetchMock.mockResolvedValueOnce(mockResponse({ bodyStream: stream }))

    const res = await fetchOnce('https://example.com/', { timeoutMs: 5000, maxBodyBytes: 10 })

    expect(res.body).toBe('a'.repeat(9))
  })

  it('流式 body:正文中混入非法 UTF-8 字节时只替换该字节,不丢弃其后内容', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x41, 0x42, 0xff, 0x43, 0x44]))
        controller.close()
      },
    })
    fetchMock.mockResolvedValueOnce(mockResponse({ bodyStream: stream }))

    const res = await fetchOnce('https://example.com/', { timeoutMs: 5000, maxBodyBytes: 100 })

    // 致命解码会在 0xff 处止步,只剩 "AB";非致命解码仅把它替换为 U+FFFD。
    expect(res.body).toBe('AB\uFFFDCD')
  })

  it('流式 body:正文内部的非法字节与截断的多字节字符可同时正确处理', async () => {
    // 0x41 0xff 之后是 "中"(E4 B8 AD):maxBodyBytes=4 恰好切在该字符中间。
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x41, 0xff, 0xe4, 0xb8, 0xad]))
        controller.close()
      },
    })
    fetchMock.mockResolvedValueOnce(mockResponse({ bodyStream: stream }))

    const res = await fetchOnce('https://example.com/', { timeoutMs: 5000, maxBodyBytes: 4 })

    expect(res.body).toBe('A\uFFFD')
  })
})

describe('fetchOnce 跳转与 cookie 作用域', () => {
  const SEARCH_HOST = 'https://weixin.sogou.com/link?url=abc'

  it('同域跳转:跟随到最终响应,每一跳都带会话 cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({
        status: 302,
        url: SEARCH_HOST,
        location: '/link?url=final',
        setCookies: ['FROM_HOP=1; Path=/'],
      }))
      .mockResolvedValueOnce(mockResponse({
        status: 200,
        url: 'https://weixin.sogou.com/link?url=final',
        body: 'ok',
      }))

    const res = await fetchOnce(SEARCH_HOST, { timeoutMs: 5000, cookieHeader: 'SUV=abc' })

    expect(res.status).toBe(200)
    expect(res.body).toBe('ok')
    expect(res.finalUrl).toBe('https://weixin.sogou.com/link?url=final')
    // 手工跟随跳转后,302 那一跳的 Set-Cookie 也能被采集到
    // (原生 redirect: 'follow' 只暴露最终响应的 Set-Cookie)。
    expect(res.setCookies).toEqual(['FROM_HOP=1; Path=/'])
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      SEARCH_HOST,
      'https://weixin.sogou.com/link?url=final',
    ])
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as { headers: Record<string, string> }).headers.Cookie).toBe('SUV=abc')
    }
  })

  it('跨域跳转:目标 host 不在白名单时不带会话 cookie(防外泄)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({
        status: 302,
        url: SEARCH_HOST,
        location: 'https://evil.example.com/steal',
        setCookies: ['FROM_SOGOU=1; Path=/'],
      }))
      .mockResolvedValueOnce(mockResponse({
        status: 200,
        url: 'https://evil.example.com/steal',
        body: 'stolen',
        setCookies: ['FROM_EVIL=1; Path=/'],
      }))

    const res = await fetchOnce(SEARCH_HOST, { timeoutMs: 5000, cookieHeader: 'SUV=abc' })

    expect((fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers.Cookie).toBe('SUV=abc')
    // 显式保证:跨域跳转目标拿不到会话 cookie,不依赖运行时对跨域跳转的隐式处理。
    expect((fetchMock.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers.Cookie).toBeUndefined()
    // 关键回归:redirect: 'follow' 下暴露的 Set-Cookie 来自**跳转目标**域,
    // updateJar 会把它收进不区分 domain 的扁平 jar,再随搜狗请求发回。
    expect(res.setCookies).toEqual(['FROM_SOGOU=1; Path=/'])
  })

  it('跳转次数达到上限后停止跟随,把该 3xx 交给调用方', async () => {
    fetchMock.mockImplementation(async (input: string | URL) =>
      mockResponse({ status: 302, url: String(input), location: '/loop' }))

    const res = await fetchOnce('https://weixin.sogou.com/loop', { timeoutMs: 5000 })

    expect(res.status).toBe(302)
    // 首次请求 + 最多 5 次跟随 = 6 次。
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('Location 非法时停止跟随而不抛异常', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 302, location: 'https://[invalid' }))

    const res = await fetchOnce('https://weixin.sogou.com/x', { timeoutMs: 5000 })

    expect(res.status).toBe(302)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('jarToHeader / updateJar', () => {
  it('jarToHeader 拼接键值对,空 jar 返回空串', () => {
    expect(jarToHeader(new Map())).toBe('')
    expect(jarToHeader(new Map([['SUV', 'a'], ['ABTEST', 'b']]))).toBe('SUV=a; ABTEST=b')
  })

  it('updateJar 正常写入并同名覆盖', () => {
    const jar = new Map([['SUV', 'old']])
    updateJar(jar, ['SUV=new; Path=/', 'ABTEST=xyz'])
    expect(jar.get('SUV')).toBe('new')
    expect(jar.get('ABTEST')).toBe('xyz')
  })

  it('Expires 为过去时间的 Set-Cookie 删除既有键', () => {
    const jar = new Map([['SUV', 'keep']])
    updateJar(jar, ['SUV=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])
    expect(jar.has('SUV')).toBe(false)
  })

  it('Max-Age 不大于 0 的 Set-Cookie 删除既有键', () => {
    const jar = new Map([['SUV', 'keep']])
    updateJar(jar, ['SUV=x; Path=/; Max-Age=0'])
    expect(jar.has('SUV')).toBe(false)
  })

  it('未来 Expires 与正 Max-Age 正常保留', () => {
    const jar = new Map<string, string>()
    updateJar(jar, ['A=1; Expires=Wed, 09 Jun 2100 10:18:14 GMT', 'B=2; Max-Age=3600'])
    expect(jar.get('A')).toBe('1')
    expect(jar.get('B')).toBe('2')
  })

  it('无 = 的畸形条目跳过', () => {
    const jar = new Map<string, string>()
    updateJar(jar, ['novalue', '=leading-eq'])
    expect(jar.size).toBe(0)
  })
})
