/**
 * 共享类型定义:解析后的搜索结果行与已解析默认值的配置。
 * 插件配置接口 `Config`(带 schemastery 校验)定义在 `index.ts`,
 * 与 dsh 官方插件惯例保持一致(接口与运行时 schema 同名同文件)。
 * @module dsh-wechat-mp-search/types
 */

/** 单条搜狗微信搜索结果。 */
export interface SearchRow {
  /** 文章标题(已去标签、HTML 实体解码)。 */
  title: string
  /** 搜狗跳转链接(已绝对化)。 */
  link: string
  /** 还原后的微信公众号真实链接;解析失败为空串。 */
  real_url: string
  /** 发布时间文本,与标题按出现顺序配对;缺失为空串。 */
  publish_time: string
  /** 结果所在的搜索页码(字符串形式,与原 Python MCP 保持一致)。 */
  page: string
}

/** 一次单页搜索的完整结果。 */
export interface SearchPageResult {
  /** 本页解析出的搜索结果行。 */
  results: SearchRow[]
  /** 是否命中反爬拦截(两次会话重试后仍失败)。 */
  blocked: boolean
}

/** 四项反爬增强能力的可调参数,全部字段均已解析出默认值。 */
export interface ResolvedConfig {
  /** 单次 HTTP 请求超时(毫秒)。默认 15000。 */
  requestTimeoutMs: number
  /** 响应体最大字节数,超出则截断(安全网)。默认 8_000_000。 */
  maxOutputBytes: number
  /** 解析链接之间的最小延迟(毫秒)。默认 200。 */
  linkDelayMs: number
  /** 解析链接之间在最小延迟基础上的随机抖动上限(毫秒)。默认 400。 */
  linkDelayJitterMs: number
  /** 翻页之间的最小延迟(毫秒)。默认 1000。 */
  pageDelayMs: number
  /** 翻页之间在最小延迟基础上的随机抖动上限(毫秒)。默认 1000。 */
  pageDelayJitterMs: number
  /** 命中反爬后重建会话重试前的最小延迟(毫秒)。默认 2500。 */
  retryDelayMs: number
  /** `weixin_search_all` 的 `max_pages` 不可被参数突破的硬上限。默认 30。 */
  maxPages: number
}

/** 解析出的标题/时间配对(内部使用,尚未绝对化链接)。 */
export interface RawSearchRow {
  title: string
  link: string
  publish_time: string
}
