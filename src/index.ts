/**
 * deepseek-harness (dsh) 插件:零配置抓取搜狗微信搜索(weixin.sogou.com),
 * 提供 `weixin_search`/`weixin_search_all`/`get_weixin_article_content` 三个工具，用于检索微信公众号文章并抓取正文。
 * @module dsh-wechat-mp-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { DEFAULT_CONFIG, DEFAULT_MAX_PAGES, DEFAULT_PAGE, doArticle, doSearch, doSearchAll, resolveConfig } from './sogou.js'

/** Cordis 插件名称。 */
export const name = 'wechat-mp-search'
/** 本插件仅依赖 `tools` 服务,不依赖 `shell`。 */
export const inject = ['tools']

/** 插件配置(四项反爬增强能力的可调参数)。 */
export interface Config {
  /** 单次 HTTP 请求超时(毫秒)。默认 15000。 */
  requestTimeoutMs?: number
  /** 响应体最大字节数,超出则截断(安全网)。默认 8_000_000。 */
  maxOutputBytes?: number
  /** 解析链接之间的最小延迟(毫秒)。默认 200。 */
  linkDelayMs?: number
  /** 解析链接之间在最小延迟基础上的随机抖动上限(毫秒)。默认 400。 */
  linkDelayJitterMs?: number
  /** 翻页之间的最小延迟(毫秒)。默认 1000。 */
  pageDelayMs?: number
  /** 翻页之间在最小延迟基础上的随机抖动上限(毫秒)。默认 1000。 */
  pageDelayJitterMs?: number
  /** 命中反爬后重建会话重试前的最小延迟(毫秒)。默认 2500。 */
  retryDelayMs?: number
  /** `weixin_search_all` 的 `max_pages` 不可被参数突破的硬上限。默认 30。 */
  maxPages?: number
}

/** Schemastery 校验规则,亦是插件配置的运行时默认值来源;数值字段均带下界,fail fast。 */
export const Config: z<Config> = z.object({
  requestTimeoutMs: z.number().min(1).default(DEFAULT_CONFIG.requestTimeoutMs),
  maxOutputBytes: z.number().min(0).default(DEFAULT_CONFIG.maxOutputBytes),
  linkDelayMs: z.number().min(0).default(DEFAULT_CONFIG.linkDelayMs),
  linkDelayJitterMs: z.number().min(0).default(DEFAULT_CONFIG.linkDelayJitterMs),
  pageDelayMs: z.number().min(0).default(DEFAULT_CONFIG.pageDelayMs),
  pageDelayJitterMs: z.number().min(0).default(DEFAULT_CONFIG.pageDelayJitterMs),
  retryDelayMs: z.number().min(0).default(DEFAULT_CONFIG.retryDelayMs),
  maxPages: z.number().min(0).default(DEFAULT_CONFIG.maxPages),
})

/** 单条搜索结果行的输出 JSON Schema。 */
const SEARCH_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true, description: '文章标题。' },
    link: { type: 'string', required: true, description: '搜狗跳转链接。' },
    real_url: { type: 'string', required: true, description: '还原后的微信公众号真实链接;解析失败为空串。' },
    publish_time: { type: 'string', required: true, description: '发布时间文本;缺失为空串。' },
    page: { type: 'string', required: true, description: '结果所在页码。' },
  },
} as const

/** `weixin_search`/`weixin_search_all` 共用的输出 JSON Schema。 */
const SEARCH_PAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: { type: 'array', required: true, items: SEARCH_ROW_SCHEMA, description: '搜索结果列表。' },
    blocked: { type: 'boolean', required: true, description: '是否命中反爬拦截(会话重试一次后仍失败)。' },
  },
} as const

/**
 * 声明一个规范输出为紧凑 JSON 文本的工具输出定义。
 * @param schema - 工具输出的规范值 schema。
 * @returns `defineTool` 所需的 `output` 声明。
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/**
 * 注册三个微信公众号搜索相关工具。
 * @param ctx - 插件上下文;工具注册的生命周期随 `ctx` 自动释放。
 * @param config - 插件配置,未提供字段使用默认值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const cfg = resolveConfig(config)

  ctx.tools.register(defineTool({
    name: 'weixin_search',
    description: '在搜狗微信搜索(weixin.sogou.com)中搜索微信公众号文章,返回单页结果。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词。' },
      // dsh-tools 参数 DSL 不支持 minimum 关键字,页码下界由下方 Math.max 钳制保证。
      page: { type: 'integer', description: '搜索结果页码,从 1 开始。默认 1。' },
    },
    output: jsonOutput(SEARCH_PAGE_OUTPUT_SCHEMA),
    async execute(args, exec) {
      const page = Math.max(DEFAULT_PAGE, args.page ?? DEFAULT_PAGE)
      return await doSearch(cfg, args.query, page, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'weixin_search_all',
    description: '在搜狗微信搜索中按页翻页搜索微信公众号文章并聚合结果,直到空页、命中反爬拦截或达到页数上限为止。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词。' },
      max_pages: {
        type: 'integer',
        description: `最多翻页数。默认 ${DEFAULT_MAX_PAGES};不能突破插件配置的硬上限(当前为 ${cfg.maxPages})。`,
      },
    },
    output: jsonOutput(SEARCH_PAGE_OUTPUT_SCHEMA),
    async execute(args, exec) {
      return await doSearchAll(cfg, args.query, args.max_pages ?? DEFAULT_MAX_PAGES, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_weixin_article_content',
    description: '抓取微信公众号文章正文纯文本。失败时返回以"获取文章内容失败:"开头的说明,而非抛出异常。',
    parameters: {
      real_url: { type: 'string', required: true, description: '微信公众号文章真实链接(https://mp.weixin.qq.com/... )。' },
      referer: { type: 'string', description: '可选的 Referer 请求头,默认使用微信域名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    async execute(args, exec) {
      return await doArticle(cfg, args.real_url, args.referer, exec.signal)
    },
  }))
}
