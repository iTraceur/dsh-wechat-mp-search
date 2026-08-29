import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, doArticle, doSearch, doSearchAll, jitterDelay, resolveConfig, resolveRealUrl } from '../src/sogou.ts'
import type { ResolvedConfig } from '../src/types.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
}

const FAST_CONFIG: ResolvedConfig = {
  requestTimeoutMs: 5000,
  maxOutputBytes: 8_000_000,
  linkDelayMs: 0,
  linkDelayJitterMs: 0,
  pageDelayMs: 0,
  pageDelayJitterMs: 0,
  retryDelayMs: 0,
  maxPages: 30,
}

interface MockResponseInit {
  status?: number
  url?: string
  body?: string
  setCookies?: string[]
}

function mockResponse(opts: MockResponseInit = {}): Response {
  const setCookies = opts.setCookies ?? []
  return {
    status: opts.status ?? 200,
    url: opts.url ?? 'https://weixin.sogou.com/weixin',
    text: () => Promise.resolve(opts.body ?? ''),
    headers: { getSetCookie: () => setCookies },
  } as unknown as Response
}

/** 一个只含单条结果的最小搜索结果页,用于精简的 cookie 累积测试。 */
const ONE_ROW_SEARCH_HTML = `
<a href="/link?url=xyz" id="sogou_vr_11002601_title_0">单条标题</a>
<span class="s2">2024-05-01</span>
`

const LINK_REDIRECT_HTML = fixture('link-redirect.html')
const SEARCH_PAGE_HTML = fixture('search-page.html')
const ANTISPIDER_HTML = fixture('search-page-antispider.html')

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('doSearch', () => {
  it('正常响应:解析结果并逐一还原真实链接', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ body: SEARCH_PAGE_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))

    const result = await doSearch(FAST_CONFIG, '测试关键词', 1)

    expect(result.blocked).toBe(false)
    expect(result.results).toHaveLength(3)
    expect(result.results[0]?.real_url).toBe(
      'https://mp.weixin.qq.com/s?__biz=MjM5NDgwNTE1MQ==&mid=22441122&idx=1&sn=abc123def456',
    )
    expect(result.results.every(row => row.page === '1')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('反爬命中重试后成功:重建全新会话再次搜索', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ body: ANTISPIDER_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: SEARCH_PAGE_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))

    const result = await doSearch(FAST_CONFIG, '测试关键词', 1)

    expect(result.blocked).toBe(false)
    expect(result.results).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('反爬命中两次后判定为 blocked,且不再解析链接', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ body: ANTISPIDER_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: ANTISPIDER_HTML }))

    const result = await doSearch(FAST_CONFIG, '测试关键词', 1)

    expect(result.blocked).toBe(true)
    expect(result.results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('非 200 状态码:返回空结果且不判定为 blocked', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 503, body: '' }))

    const result = await doSearch(FAST_CONFIG, '测试关键词', 1)

    expect(result).toEqual({ results: [], blocked: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('会话内 cookie 累积:搜索响应的 Set-Cookie 会带到后续链接解析请求', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ body: ONE_ROW_SEARCH_HTML, setCookies: ['SUV=abc123; Path=/; Domain=.sogou.com'] }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))

    const result = await doSearch(FAST_CONFIG, '测试关键词', 1)

    expect(result.blocked).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const secondCallInit = fetchMock.mock.calls[1]?.[1] as { headers?: Record<string, string> }
    expect(secondCallInit.headers?.Cookie).toContain('SUV=abc123')
  })

  it('网络异常(signal 未取消)返回空结果而非抛出', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    const result = await doSearch(FAST_CONFIG, '测试关键词', 1)

    expect(result).toEqual({ results: [], blocked: false })
  })

  it('外部 signal 已取消时向上抛出 AbortError 而非返回空结果', async () => {
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockRejectedValueOnce(controller.signal.reason)

    await expect(doSearch(FAST_CONFIG, '测试关键词', 1, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('非搜狗域的绝对链接行被整行丢弃,不对其发请求', async () => {
    const MIXED_LINKS_HTML = `
<a href="https://evil.example.com/link" id="sogou_vr_11002601_title_0">恶意结果</a>
<a href="/link?url=xyz" id="sogou_vr_11002601_title_1">正常结果</a>
<span class="s2">2024-05-01</span>
`
    fetchMock
      .mockResolvedValueOnce(mockResponse({ body: MIXED_LINKS_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))

    const result = await doSearch(FAST_CONFIG, '测试关键词', 1)

    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.title).toBe('正常结果')
    // 仅 1 次搜索 + 1 次合法链接解析;恶意链接未发请求。
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('resolveRealUrl', () => {
  it('累积响应的 Set-Cookie 到传入的 jar', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML, setCookies: ['ABTEST=xyz; Path=/'] }))
    const jar = new Map<string, string>()

    const realUrl = await resolveRealUrl(FAST_CONFIG, 'https://weixin.sogou.com/link?url=abc', jar)

    expect(realUrl).toBe('https://mp.weixin.qq.com/s?__biz=MjM5NDgwNTE1MQ==&mid=22441122&idx=1&sn=abc123def456')
    expect(jar.get('ABTEST')).toBe('xyz')
  })

  it('请求异常时返回空串而不抛出', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const jar = new Map<string, string>()

    await expect(resolveRealUrl(FAST_CONFIG, 'https://weixin.sogou.com/link?url=abc', jar)).resolves.toBe('')
  })

  it('外部 signal 已取消时向上抛出 AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockRejectedValueOnce(controller.signal.reason)
    const jar = new Map<string, string>()

    await expect(resolveRealUrl(FAST_CONFIG, 'https://weixin.sogou.com/link?url=abc', jar, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('doSearchAll 翻页中途命中反爬', () => {
  it('立即停止翻页并保留已聚合结果', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ body: SEARCH_PAGE_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: ANTISPIDER_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: ANTISPIDER_HTML }))

    const result = await doSearchAll(FAST_CONFIG, '测试关键词', 5)

    expect(result.blocked).toBe(true)
    expect(result.results).toHaveLength(3)
    // 第 1 页 4 次请求 + 第 2 页两次反爬 2 次,共 6 次。
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})

describe('doArticle 取消传播', () => {
  it('外部 signal 已取消时向上抛出 AbortError 而非返回失败文案', async () => {
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockRejectedValueOnce(controller.signal.reason)

    await expect(doArticle(FAST_CONFIG, 'https://mp.weixin.qq.com/s?x=1', undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('jitterDelay', () => {
  it('min=max=0 时立即返回', async () => {
    await expect(jitterDelay(0, 0)).resolves.toBeUndefined()
  })

  it('进入等待前 signal 已取消时立即拒绝', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(jitterDelay(10, 10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('等待期间取消:提前拒绝而非睡满', async () => {
    const controller = new AbortController()
    const pending = jitterDelay(5000, 5000, controller.signal)
    setTimeout(() => controller.abort(), 10)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('正常等待至完成', async () => {
    await expect(jitterDelay(1, 1)).resolves.toBeUndefined()
  })
})

describe('resolveConfig 下界钳制', () => {
  it('负数与 NaN 回退默认值,有效值保留', () => {
    const cfg = resolveConfig({ requestTimeoutMs: -1, linkDelayMs: Number.NaN, maxPages: 5 })

    expect(cfg.requestTimeoutMs).toBe(DEFAULT_CONFIG.requestTimeoutMs)
    expect(cfg.linkDelayMs).toBe(DEFAULT_CONFIG.linkDelayMs)
    expect(cfg.maxPages).toBe(5)
  })

  it('空覆盖得到完整默认配置', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG)
  })
})
