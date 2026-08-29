import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../src/mcp-server.ts'
import type { ResolvedConfig } from '../src/types.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
}

const LINK_REDIRECT_HTML = fixture('link-redirect.html')
const SEARCH_PAGE_HTML = fixture('search-page.html')

/** 压低各延迟参数,让走抖动限速路径的用例保持毫秒级耗时。 */
const FAST_CONFIG: Partial<ResolvedConfig> = {
  requestTimeoutMs: 5000,
  linkDelayMs: 0,
  linkDelayJitterMs: 0,
  pageDelayMs: 0,
  pageDelayJitterMs: 0,
  retryDelayMs: 0,
}

interface MockResponseInit {
  status?: number
  url?: string
  body?: string
  setCookies?: string[]
}

function mockResponse(opts: MockResponseInit = {}): Response {
  return {
    status: opts.status ?? 200,
    url: opts.url ?? 'https://weixin.sogou.com/weixin',
    text: () => Promise.resolve(opts.body ?? ''),
    headers: { getSetCookie: () => opts.setCookies ?? [] },
  } as unknown as Response
}

/** 用 InMemoryTransport 连接一个真实 client 与被测 server。 */
async function connectPair(): Promise<Client> {
  const server = createMcpServer(FAST_CONFIG)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

/** 取 CallToolResult 首个 text 内容块;错误分支可能没有 content,返回空串。 */
function firstText(res: unknown): string {
  const content = (res as { content?: unknown }).content
  const blocks = (content ?? []) as { type: string; text: string }[]
  return blocks[0]?.text ?? ''
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createMcpServer', () => {
  it('listTools 暴露 3 个工具,名称与必填参数和 dsh 入口一致', async () => {
    const client = await connectPair()

    const { tools } = await client.listTools()
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    expect([...byName.keys()]).toEqual(['weixin_search', 'weixin_search_all', 'get_weixin_article_content'])
    expect(byName.get('weixin_search')?.inputSchema).toMatchObject({ type: 'object', required: ['query'] })
    expect(byName.get('weixin_search_all')?.inputSchema).toMatchObject({ type: 'object', required: ['query'] })
    expect(byName.get('get_weixin_article_content')?.inputSchema).toMatchObject({ type: 'object', required: ['real_url'] })
  })

  it('callTool weixin_search 返回 JSON 序列化的结果行', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ body: SEARCH_PAGE_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
      .mockResolvedValueOnce(mockResponse({ body: LINK_REDIRECT_HTML }))
    const client = await connectPair()

    const res = await client.callTool({ name: 'weixin_search', arguments: { query: '测试关键词' } })
    const parsed = JSON.parse(firstText(res)) as { results: unknown[]; blocked: boolean }

    expect(parsed.blocked).toBe(false)
    expect(parsed.results).toHaveLength(3)
  })

  it('callTool get_weixin_article_content 对无效链接返回失败说明字符串', async () => {
    const client = await connectPair()

    const res = await client.callTool({ name: 'get_weixin_article_content', arguments: { real_url: '' } })

    expect(firstText(res)).toBe('获取文章内容失败: 未拿到有效的微信公众号文章链接')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('参数校验:缺少必填 query 时返回 isError 而非抛出异常', async () => {
    const client = await connectPair()

    const res = await client.callTool({ name: 'weixin_search', arguments: {} })

    expect(res.isError).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
