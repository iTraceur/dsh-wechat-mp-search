import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchOnce, jarToHeader, updateJar } from '../src/http.ts'

interface MockResponseInit {
  status?: number
  url?: string
  body?: string
  setCookies?: string[]
  /** 可选的流式响应体;提供时走 `response.body` 流式读取路径。 */
  bodyStream?: ReadableStream<Uint8Array>
}

function mockResponse(opts: MockResponseInit = {}): Response {
  const base: Record<string, unknown> = {
    status: opts.status ?? 200,
    url: opts.url ?? 'https://example.com/',
    text: () => Promise.resolve(opts.body ?? ''),
    headers: { getSetCookie: () => opts.setCookies ?? [] },
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
