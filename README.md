# dsh-wechat-mp-search

[![npm](https://img.shields.io/npm/v/dsh-wechat-mp-search)](https://www.npmjs.com/package/dsh-wechat-mp-search)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件，同时提供同构的 **MCP server** 入口：零配置抓取搜狗微信搜索（weixin.sogou.com），用于检索微信公众号文章并抓取正文。

两种分发形态共享同一套核心逻辑（`src/sogou.ts`），工具名、参数与返回字段完全一致：

- **dsh 插件**（`src/index.ts`）：进程内 Cordis 插件，随宿主 dsh 运行时加载；
- **MCP server**（`src/mcp-server.ts`）：标准 Model Context Protocol stdio server，供 Claude Code、Cursor、Codex 等任意 MCP 客户端使用。

## 工具

| 工具名                       | 参数                                                     | 说明                                                         |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `weixin_search`              | `query: string`（必填）、`page?: number`（默认 1）       | 搜索单页结果，返回 `{ results, blocked, error? }`。          |
| `weixin_search_all`          | `query: string`（必填）、`max_pages?: number`（默认 10） | 按页翻页搜索，直到达到页数上限、空页、命中反爬拦截或某页出错；`max_pages` 会被插件配置的硬上限（`maxPages`）截断。 |
| `get_weixin_article_content` | `real_url: string`（必填）、`referer?: string`           | 抓取文章正文纯文本；失败时返回 `获取文章内容失败: ...` 字符串而非抛异常。 |

`weixin_search`/`weixin_search_all` 返回的每条结果字段：`title`、`link`（搜狗跳转链接）、`real_url`（还原后的微信公众号真实链接，解析失败为空串）、`publish_time`（取自该条结果所属的结果块，缺失为空串）、`page`。

## 反爬 / 限流策略

本插件进行了四项反爬增强，均可通过插件配置调整：

1. **会话级 cookie jar**：同一次搜索会话内（一次 `weixin_search` 调用及其后续链接解析请求）共享并累积 `Set-Cookie`，使后续请求携带前序请求获得的 cookie。cookie 只发给 `weixin.sogou.com`，也只从该域采集。
2. **请求间限速抖动**：链接解析之间使用 `linkDelayMs` + `[0, linkDelayJitterMs)` 随机抖动延迟；`weixin_search_all` 翻页之间使用 `pageDelayMs` + `[0, pageDelayJitterMs)` 随机抖动延迟。
3. **反爬重试**：命中反爬验证（响应体或跳转后 URL 出现反爬特征），或返回 `403`/`429`/`503` 这类拒绝/限流状态码时，重建一个全新会话（全新 cookie jar）重试一次；仍失败才判定为 `blocked: true`。
4. **`max_pages` 硬上限**：`weixin_search_all` 的 `max_pages` 参数无法突破插件配置项 `maxPages`（默认 30）。

跳转由本插件手动跟随（上限 5 跳）而非交给 fetch 的 `redirect: 'follow'`：跨域跳转目标因此拿不到会话 cookie，其下发的 `Set-Cookie` 也不会被收进 jar。这两点是代码里的显式约束，而不是依赖运行时的隐式行为——`follow` 只暴露最终响应的 `Set-Cookie`，而中间跳转响应上的会被丢弃；jar 又是扁平的 name→value、不区分 domain，混入第三方域的 cookie 后会被随后的搜狗域请求一起发回。

### 失败语义：`blocked` 与 `error`

两个字段分工明确，避免把失败伪装成“搜索无结果”：

- `blocked: true`：搜狗在拦我们。命中反爬验证页，或返回 `403`/`429`/`503` 这类明确的拒绝/限流状态码，且重建会话重试一次后仍然失败。
- `error`（可选，存在即表示本次调用失败）：传输层异常（超时、DNS、连接失败）或非预期状态码（如 `500`）。此时 `results` 必为空数组。
- 两者都没有且 `results` 为空：搜索**确实**没有结果。

`weixin_search_all` 在任意一页出现 `blocked` 或 `error` 时停止翻页，并把该页的字段原样带出、保留已聚合的结果——中间页的失败不会被“聚合成功”掩盖。

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

## 兼容性（dsh 版本）

`peerDependencies` 声明 `@deepseek-ai/dsh-tools: "^0.1.1-rc.2 || ^0.2.0-rc.1"`，即同时支持 0.1.x 与 0.2.x 两条 API 线，加载时不会被 dsh 的兼容性护栏拦下。

本插件只用到 `defineTool`、`InferValue`、`ValueSchemaSpec`、`ToolDefinition`、`ToolRunContext` 这几个 API。dsh-tools 0.2 的改动（`code-mode` 模块重命名为 `ptc`、`CallId` 改名 `ToolCallId`、`JsonValue` 的导入源由 `dsh-session` 迁到 `dsh-util-values`）都不在本插件的使用面上，因此两条线可共用同一份代码。

dsh 的兼容性护栏（`pluginCompatibilityWarning`）只校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 命名的 peer，比较对象是 **dsh 自身版本**，且判定用 `semver.satisfies(version, range, { includePrerelease: true })`。两个要点：

1. caret 的范围不会跨 minor：`^0.1.1-rc.2` 不含 0.2.x，所以 dsh 升级到 0.2.0 后必须显式补上 `^0.2.0-rc.x`，否则就会被拦下（这正是 0.1.0 遇到的问题）；
2. 0.2.x 的下界取 `rc.1` 而非 `rc.2`：`^0.2.0-rc.2` 会把仍在 `0.2.0-rc.1` 的运行时判成不兼容。

下界是**实测**出来的：0.1.1-rc.2、0.2.0-rc.1、0.2.0-rc.2 三个版本各自安装后，`tsc -p tsconfig.test.json` 与 `vitest run`（82 个用例）全部通过。升级 dsh 的 minor 线时，请同步更新 `devDependencies` 里的 `@deepseek-ai/dsh-tools`，让类型检查跟得上运行时。

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
npm run build       # tsc -p tsconfig.json(仅 src,产出 lib/)
npm run typecheck   # tsc -p tsconfig.test.json(src + tests,含测试)
npm test            # vitest run
```

> `typecheck` 特意覆盖 `tests/`。构建用的 `tsconfig.json` 只 `include: ["src"]`（测试以
> `../src/x.ts` 直接导入 TS 源码，需要 `allowImportingTsExtensions`，与 emit 冲突），
> 而 vitest 只做转译不做类型检查——若不给测试单独配一份 `tsconfig.test.json`，
> 测试文件里的类型错误无人把关，dsh-tools 之类的 peer API 变更就会静默溜进发布。

> `peerDependencies` 中的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 由宿主 dsh 运行时提供。
> 本仓库的 `.npmrc` 已将 registry 指向官方 `https://registry.npmjs.org/`，因为这几个包
> （含其自身的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session` 等传递 peer 依赖）已在公网 npm
> 发布对应版本，可直接 `npm install`；若你的环境配置了指向其他镜像源的全局 registry，
> 请临时使用 `--registry=https://registry.npmjs.org/` 或本仓库自带的 `.npmrc`。

## 免责声明

仅学习研究使用，请控制请求频率，遵守搜狗 / 微信与相关法规。目标站点接口变更可能导致解析逻辑失效
