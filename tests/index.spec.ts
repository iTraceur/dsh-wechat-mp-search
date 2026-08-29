import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

/**
 * 构造一个只满足 `apply()` 实际用到的接口子集的假 Context。
 * `defineTool` 本身不 mock,真实执行其 schema 编译与校验逻辑,
 * 借此确认三个工具的 `parameters`/`output.schema` 均通过 dsh-tools 的编译期检查。
 */
function createFakeContext(): { ctx: Context; register: ReturnType<typeof vi.fn> } {
  const register = vi.fn((_definition: ToolDefinition) => () => {})
  const ctx = { tools: { register } } as unknown as Context
  return { ctx, register }
}

describe('apply', () => {
  it('注册 3 个工具,名称与参数字段名和原 Python MCP 保持一致', () => {
    const { ctx, register } = createFakeContext()

    expect(() => { apply(ctx, {}) }).not.toThrow()

    expect(register).toHaveBeenCalledTimes(3)
    const definitions = register.mock.calls.map(call => call[0] as ToolDefinition)
    const byName = new Map(definitions.map(def => [def.name, def]))

    expect([...byName.keys()]).toEqual(['weixin_search', 'weixin_search_all', 'get_weixin_article_content'])

    const search = byName.get('weixin_search')
    expect(search?.parameters).toMatchObject({
      type: 'object',
      properties: {
        query: expect.objectContaining({ type: 'string' }),
        page: expect.objectContaining({ type: 'integer' }),
      },
      required: ['query'],
    })

    const searchAll = byName.get('weixin_search_all')
    expect(searchAll?.parameters).toMatchObject({
      type: 'object',
      properties: {
        query: expect.objectContaining({ type: 'string' }),
        max_pages: expect.objectContaining({ type: 'integer' }),
      },
      required: ['query'],
    })

    const article = byName.get('get_weixin_article_content')
    expect(article?.parameters).toMatchObject({
      type: 'object',
      properties: {
        real_url: expect.objectContaining({ type: 'string' }),
        referer: expect.objectContaining({ type: 'string' }),
      },
      required: ['real_url'],
    })
  })

  it('搜索类工具的输出 schema 中所有 object 节点均显式声明 additionalProperties: false', () => {
    const { ctx, register } = createFakeContext()
    apply(ctx, {})
    const definitions = register.mock.calls.map(call => call[0] as ToolDefinition)
    const byName = new Map(definitions.map(def => [def.name, def]))

    const outputSchema = byName.get('weixin_search')?.output.schema as Record<string, unknown>
    expect(outputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    const properties = outputSchema.properties as Record<string, unknown>
    const resultsItems = (properties.results as { items: Record<string, unknown> }).items
    expect(resultsItems).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('未传配置时使用默认值,不抛异常', () => {
    const { ctx } = createFakeContext()
    expect(() => { apply(ctx, undefined) }).not.toThrow()
  })
})

describe('Config 校验', () => {
  it('低于下界的数值配置被拒绝(fail fast)', () => {
    expect(() => { Config({ requestTimeoutMs: 0 }) }).toThrow()
    expect(() => { Config({ linkDelayMs: -1 }) }).toThrow()
    expect(() => { Config({ maxPages: -1 }) }).toThrow()
  })

  it('合法空配置通过校验并填充默认值', () => {
    expect(Config({})).toMatchObject({ maxPages: 30, requestTimeoutMs: 15_000 })
  })
})

describe('weixin_search_all 的 max_pages 硬上限', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  /** 单行结果的搜索页:每页触发 1 次搜索请求 + 1 次链接解析请求。 */
  const ONE_ROW_SEARCH_HTML = `
<a href="/link?url=xyz" id="sogou_vr_11002601_title_0">单条标题</a>
<span class="s2">2024-05-01</span>
`
  const LINK_REDIRECT_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'link-redirect.html'), 'utf8')

  function mockResponse(body: string): Response {
    return {
      status: 200,
      url: 'https://weixin.sogou.com/weixin',
      text: () => Promise.resolve(body),
      headers: { getSetCookie: () => [] },
    } as unknown as Response
  }

  beforeEach(() => {
    fetchMock = vi.fn(async (input: string | URL) =>
      String(input).includes('/link')
        ? mockResponse(LINK_REDIRECT_HTML)
        : mockResponse(ONE_ROW_SEARCH_HTML),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function getSearchAllTool() {
    const { ctx, register } = createFakeContext()
    apply(ctx, {
      pageDelayMs: 0,
      pageDelayJitterMs: 0,
      linkDelayMs: 0,
      linkDelayJitterMs: 0,
      retryDelayMs: 0,
    })
    const definitions = register.mock.calls.map(call => call[0] as ToolDefinition)
    const searchAll = definitions.find(def => def.name === 'weixin_search_all')
    if (searchAll === undefined) throw new Error('weixin_search_all 未注册')
    return searchAll
  }

  const exec = { signal: new AbortController().signal } as unknown as ToolRunContext

  it('args.max_pages 无法突破插件配置的 maxPages 硬上限', async () => {
    const { ctx, register } = createFakeContext()
    apply(ctx, {
      maxPages: 2,
      pageDelayMs: 0,
      pageDelayJitterMs: 0,
      linkDelayMs: 0,
      linkDelayJitterMs: 0,
      retryDelayMs: 0,
    })
    const definitions = register.mock.calls.map(call => call[0] as ToolDefinition)
    const searchAll = definitions.find(def => def.name === 'weixin_search_all')
    if (searchAll === undefined) throw new Error('weixin_search_all 未注册')

    const result = await searchAll.execute({ query: '测试关键词', max_pages: 100 }, exec) as { blocked: boolean }

    expect(result.blocked).toBe(false)
    // maxPages 硬上限为 2:即便请求 100 页,也只执行 2 页,
    // 每页 1 次搜索 + 1 次链接解析 = 共 4 次底层请求。
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('args.max_pages 小于硬上限时按请求值执行', async () => {
    const searchAll = getSearchAllTool()

    await searchAll.execute({ query: '测试关键词', max_pages: 3 }, exec)

    // 3 页 × (1 次搜索 + 1 次链接解析) = 6 次。
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('空页(已无更多结果)提前终止翻页', async () => {
    fetchMock.mockImplementation(async () => mockResponse('<html><body>no results on this page</body></html>'))
    const searchAll = getSearchAllTool()

    const result = await searchAll.execute({ query: '测试关键词', max_pages: 5 }, exec) as { results: unknown[]; blocked: boolean }

    expect(result.blocked).toBe(false)
    expect(result.results).toEqual([])
    // 第 1 页即为空页:立即停止,不再请求第 2~5 页。
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
