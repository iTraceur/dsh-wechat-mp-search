#!/usr/bin/env node
/**
 * MCP server 入口:把本包的核心搜索/抓取能力(含四项反爬增强)以标准 MCP
 * 工具形式暴露给任意 MCP 客户端(Claude Code / Cursor / Codex 等)。
 * 与 dsh 插件入口(`index.ts`)共享 `sogou.ts` 同一套核心逻辑,零配置运行。
 * @module dsh-wechat-mp-search/mcp-server
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DEFAULT_MAX_PAGES, DEFAULT_PAGE, doArticle, doSearch, doSearchAll, resolveConfig } from './sogou.js'
import type { ResolvedConfig } from './types.js'

const { version: PACKAGE_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/** MCP 工具输出的 JSON 文本内容块。 */
function jsonText(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** 注册 `weixin_search` 与 `weixin_search_all` 两个搜索类工具。 */
function registerSearchTools(server: McpServer, cfg: ResolvedConfig): void {
  server.registerTool(
    'weixin_search',
    {
      description: '在搜狗微信搜索(weixin.sogou.com)中搜索微信公众号文章,返回单页结果。',
      inputSchema: {
        query: z.string().describe('搜索关键词'),
        page: z.number().int().min(1).optional().describe('搜索结果页码,从 1 开始,默认 1'),
      },
    },
    async ({ query, page }) => {
      const result = await doSearch(cfg, query, page ?? DEFAULT_PAGE)
      return { content: jsonText(result) }
    },
  )

  server.registerTool(
    'weixin_search_all',
    {
      description:
        '自动翻页搜索多页微信公众号文章并聚合结果,直到空页、命中反爬拦截或达到页数上限为止。',
      inputSchema: {
        query: z.string().describe('搜索关键词'),
        max_pages: z.number().int().min(1).optional().describe('最多翻页数,默认 10;不可超过服务端硬上限'),
      },
    },
    async ({ query, max_pages }) => {
      const result = await doSearchAll(cfg, query, max_pages ?? DEFAULT_MAX_PAGES)
      return { content: jsonText(result) }
    },
  )
}

/** 注册 `get_weixin_article_content` 正文抓取工具。 */
function registerArticleTool(server: McpServer, cfg: ResolvedConfig): void {
  server.registerTool(
    'get_weixin_article_content',
    {
      description:
        '抓取微信公众号文章正文纯文本。失败时返回以"获取文章内容失败:"开头的说明,而非报错。',
      inputSchema: {
        real_url: z.string().describe('微信公众号文章真实链接(https://mp.weixin.qq.com/...)'),
        referer: z.string().optional().describe('可选的 Referer 请求头'),
      },
    },
    async ({ real_url, referer }) => {
      const content = await doArticle(cfg, real_url, referer)
      return { content: [{ type: 'text' as const, text: content }] }
    },
  )
}

/**
 * 创建已注册三个微信公众号搜索工具的 MCP server。
 * 供 stdio 启动与测试(InMemoryTransport)复用。
 * @param config - 可选配置覆盖,字段与 dsh 插件的 `Config` 一致,缺省取默认值。
 * @returns 已完成工具注册、尚未连接 transport 的 `McpServer`。
 */
export function createMcpServer(config: Partial<ResolvedConfig> = {}): McpServer {
  const cfg = resolveConfig(config)
  const server = new McpServer(
    { name: 'dsh-wechat-mp-search', version: PACKAGE_VERSION },
    {
      instructions:
        '微信公众号搜狗搜索工具(移植自 weixin_search_mcp,带会话 cookie、限速抖动、反爬重试、页数硬上限四项反爬增强)。请控制调用频率,仅用于学习研究。',
    },
  )
  registerSearchTools(server, cfg)
  registerArticleTool(server, cfg)
  return server
}

/** 以 stdio transport 启动 MCP server(作为独立进程被 MCP 客户端拉起)。 */
async function main(): Promise<void> {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())
}

// 仅在作为 CLI 直接执行时启动 stdio 服务;被 import(如测试)时不自动连接。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
