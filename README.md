# dsh-wechat-mp-search

[deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件，同时提供同构的 **MCP server** 入口：零配置抓取搜狗微信搜索（weixin.sogou.com），用于检索微信公众号文章并抓取正文。

两种分发形态共享同一套核心逻辑（`src/sogou.ts`），工具名、参数与返回字段完全一致：

- **dsh 插件**（`src/index.ts`）：进程内 Cordis 插件，随宿主 dsh 运行时加载；
- **MCP server**（`src/mcp-server.ts`）：标准 Model Context Protocol stdio server，供 Claude Code、Cursor、Codex 等任意 MCP 客户端使用。

## 工具

| 工具名                       | 参数                                                     | 说明                                                         |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `weixin_search`              | `query: string`（必填）、`page?: number`（默认 1）       | 搜索单页结果，返回 `{ results, blocked }`。                  |
| `weixin_search_all`          | `query: string`（必填）、`max_pages?: number`（默认 10） | 按页翻页搜索，直到达到页数上限或命中反爬拦截；`max_pages` 会被插件配置的硬上限（`maxPages`）截断。 |
| `get_weixin_article_content` | `real_url: string`（必填）、`referer?: string`           | 抓取文章正文纯文本；失败时返回 `获取文章内容失败: ...` 字符串而非抛异常。 |

`weixin_search`/`weixin_search_all` 返回的每条结果字段：`title`、`link`（搜狗跳转链接）、`real_url`（还原后的微信公众号真实链接，解析失败为空串）、`publish_time`、`page`。

## 反爬 / 限流策略

本插件进行了四项反爬增强，均可通过插件配置调整：

1. **会话级 cookie jar**：同一次搜索会话内（一次 `weixin_search` 调用及其后续链接解析请求）共享并累积 `Set-Cookie`，使后续请求携带前序请求获得的 cookie。
2. **请求间限速抖动**：链接解析之间使用 `linkDelayMs` + `[0, linkDelayJitterMs)` 随机抖动延迟；`weixin_search_all` 翻页之间使用 `pageDelayMs` + `[0, pageDelayJitterMs)` 随机抖动延迟。
3. **反爬重试**：命中反爬验证（响应体或跳转后 URL 出现反爬特征）时，重建一个全新会话（全新 cookie jar）重试一次；仍失败才判定为 `blocked: true`。
4. **`max_pages` 硬上限**：`weixin_search_all` 的 `max_pages` 参数无法突破插件配置项 `maxPages`（默认 30）。

### 配置项

| 配置项                              | 默认值          | 说明                                                         |
| ----------------------------------- | --------------- | ------------------------------------------------------------ |
| `requestTimeoutMs`                  | `15000`         | 单次 HTTP 请求超时（毫秒）。                                 |
| `maxOutputBytes`                    | `8000000`       | 响应体最大字节数；流式读取达到上限即停止下载并按字符边界截断。 |
| `linkDelayMs` / `linkDelayJitterMs` | `200` / `400`   | 链接解析之间的最小延迟与随机抖动上限。                       |
| `pageDelayMs` / `pageDelayJitterMs` | `1000` / `1000` | 翻页之间的最小延迟与随机抖动上限。                           |
| `retryDelayMs`                      | `2500`          | 命中反爬后重建会话重试前的最小延迟。                         |
| `maxPages`                          | `30`            | `weixin_search_all` 的 `max_pages` 硬上限。                  |

各数值配置项均有下界（如 `requestTimeoutMs >= 1`，延迟类 `>= 0`）：dsh 形态下非法值会在插件加载时被校验拒绝；MCP 形态（不经过配置校验）会将非法值（负数、`NaN` 等）回退为默认值。

## 安装

### dsh 插件

```bash
# 本地路径安装
dsh plugin --profile <profile-name> add ${workspace}/dsh-wechat-mp-search

# 发布到 npm 后
dsh plugin --profile <profile-name> add dsh-wechat-mp-search
```

### MCP server（任意 MCP 客户端）

本包的默认可执行入口即 MCP stdio server。

**本地路径使用（无需发布到 npm）**：先用 `npm install && npm run build` 生成 `lib/`，然后在支持 MCP 的客户端中添加：

```json
{
  "mcpServers": {
    "wechat-mp-search": {
      "command": "node",
      "args": ["${workspace}/dsh-wechat-mp-search/lib/mcp-server.js"]
    }
  }
}
```

Claude Code 也可以一行命令添加：

```bash
claude mcp add wechat-mp-search -- node ${workspace}/dsh-wechat-mp-search/lib/mcp-server.js
```

修改源码后重新 `npm run build` 即生效。频繁迭代可在项目目录执行 `npm link`，之后配置直接写 `"command": "dsh-wechat-mp-search"`。

**发布到 npm 后**：

```json
{
  "mcpServers": {
    "wechat-mp-search": {
      "command": "npx",
      "args": ["-y", "dsh-wechat-mp-search"]
    }
  }
}
```

或全局安装后直接使用命令：

```bash
npm install -g dsh-wechat-mp-search
# 客户端配置: { "command": "dsh-wechat-mp-search" }
```

MCP 入口零配置运行，各反爬参数使用上文默认值；需要自定义时可在 dsh 形态下通过插件 `config` 调整。

## 开发

```bash
npm install
npm run build       # tsc -p tsconfig.json
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

> `peerDependencies` 中的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 由宿主 dsh 运行时提供。
> 本仓库的 `.npmrc` 已将 registry 指向官方 `https://registry.npmjs.org/`，因为这几个包
> （含其自身的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session` 等传递 peer 依赖）已在公网 npm
> 发布对应版本，可直接 `npm install`；若你的环境配置了指向其他镜像源的全局 registry，
> 请临时使用 `--registry=https://registry.npmjs.org/` 或本仓库自带的 `.npmrc`。

## 免责声明

仅学习研究使用，请控制请求频率，遵守搜狗 / 微信与相关法规。目标站点接口变更可能导致解析逻辑失效
