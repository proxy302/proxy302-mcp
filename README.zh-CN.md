<p align="center"><img src="https://raw.githubusercontent.com/proxy302/proxy302-mcp/main/docs/images/hero.svg" alt="proxy302-mcp：给 AI 助手用的住宅代理工具" width="100%"></p>

# proxy302-mcp

> **Proxy302 官方 MCP 服务器**，由 Proxy302 团队开发和维护。账户、计费、连接问题请联系 [Proxy302 客服](https://proxy302.com/zh/)；这个服务器本身的 bug 请提 [GitHub issue](https://github.com/proxy302/proxy302-mcp/issues)。

给你的 AI 助手一套真正的住宅代理工具。`proxy302-mcp` 是 [Proxy302](https://proxy302.com) 的 [MCP](https://modelcontextprotocol.io) 服务器：在 Claude Code、Claude Desktop、Cursor 等工具里查流量和用量、看可用国家和套餐、按国家拿动态住宅代理连接串、列出你的代理和静态 IP，还能通过代理抓取网页。

[English](README.md)

<p align="center"><img src="https://raw.githubusercontent.com/proxy302/proxy302-mcp/main/docs/images/how-it-works.svg" alt="工作原理：AI 助手调用你电脑上的 proxy302-mcp，它用你的密钥调用 Proxy302 接口，并通过住宅 IP 抓取网页" width="100%"></p>

> v1 只做只读、不花钱的功能：不购买、不续费、不充值。唯一的写操作（创建动态代理凭证）免费、默认关闭，只在你真正使用时才按流量计费。

## 不用安装：直接连官方托管的服务器

Proxy302 托管了同一套服务。先在 [Proxy302 控制台](https://proxy302.com/api-keys) 创建 API 密钥。

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=proxy302&config=eyJ1cmwiOiJodHRwczovL21jcC5wcm94eTMwMi5jb20vbWNwIn0%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Proxy302-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=proxy302&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.proxy302.com%2Fmcp%22%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Proxy302-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=proxy302&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.proxy302.com%2Fmcp%22%7D&quality=insiders)

点一下就会添加 `https://mcp.proxy302.com/mcp`，应用随后打开 Proxy302 登录窗口，贴一次 API 密钥（`key id:secret`）就连上了。在控制台删掉密钥，连接就断开。

- **Claude**（claude.ai、Claude 桌面版）：设置 → 连接器 → 添加自定义连接器，地址填 `https://mcp.proxy302.com/mcp`。
- **ChatGPT**（开发者模式）：用同一个地址新建连接器，认证选 OAuth。
- **Cursor、VS Code、Windsurf 等其他 MCP 客户端：** 同一个地址，不用填请求头。

**用 OAuth 登录：** 在 Claude、ChatGPT 等支持 MCP 登录的客户端里，把 `https://mcp.proxy302.com/mcp` 添加为自定义连接器，在弹出的登录窗口里贴一次 API 密钥即可。Claude Code：

```bash
claude mcp add --transport http proxy302 https://mcp.proxy302.com/mcp
```

然后在 Claude Code 里运行 `/mcp` 完成登录。

**或者用请求头带密钥：** 地址 `https://proxy302.com/v1/mcp`，请求头 `Authorization: Bearer <key id>:<secret>`。

```bash
claude mcp add --transport http proxy302 https://proxy302.com/v1/mcp --header "Authorization: Bearer <key id>:<secret>"
```

Cursor（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "proxy302": {
      "url": "https://proxy302.com/v1/mcp",
      "headers": { "Authorization": "Bearer <key id>:<secret>" }
    }
  }
}
```

托管版的工具和本地版一样，不含 `fetch_url`，另外多了 `check_ip_purity`（查你的静态 IP 或某个地区下一批 IP 的黑名单评分）、`estimate_cost`（按你的账户报价、看钱包够不够）。同样不会花钱。

## 在本机运行：一条命令安装

先在 Proxy302 控制台创建 API 密钥，记下 key id 和 secret。需要 Node.js 20+。

福利：付费账户第一次通过 proxy302-mcp 调用成功，Proxy302 会送 **1 PTC**（每个账户一次）。

```bash
claude mcp add proxy302 -e PROXY302_API_KEY="<key id>:<secret>" -- npx -y github:proxy302/proxy302-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "proxy302": {
      "command": "npx",
      "args": ["-y", "github:proxy302/proxy302-mcp"],
      "env": { "PROXY302_API_KEY": "<key id>:<secret>" }
    }
  }
}
```

### Cursor

把同样的片段放进 `~/.cursor/mcp.json`。

## 工具

| 工具 | 作用 |
|---|---|
| `get_account_usage` | 账号、钱包 PTC 余额、剩余预付流量、各流量包余额、最近 N 天用量 |
| `list_countries` | 可定向的国家（含 id 和 ISO 代码） |
| `list_regions` | 某国的州，或某州的城市 |
| `list_products` | 产品线与静态 IP 套餐 |
| `get_dynamic_proxy` | 按国家返回可直接使用的动态住宅代理 URL（优质线路还能到州、城市、运营商）。`session_mode=rotate` 每个新连接换 IP，`sticky`（默认）保持一个 IP；低价线路可用 `session_minutes` 设 10–120 分钟。优先复用同线路同地区的已有代理，`create_if_missing=true` 时才创建，有流量包扣流量包、没有就按量扣钱包 |
| `list_isps` | 某国优质线路可指定的运营商 |
| `rotate_ip` | 粘性代理换出口 IP：返回一个新会话的地址，立即生效 |
| `list_my_proxies` | 你的动态代理和静态 IP，密码默认打码 |
| `fetch_url` | 通过你的代理（可指定出口国家）请求网址，返回 Markdown、纯文本或原文 |

## 示例

<p align="center"><img src="https://raw.githubusercontent.com/proxy302/proxy302-mcp/main/docs/images/demo.svg" alt="示例：查剩余流量、拿德国代理、通过代理抓网页" width="100%"></p>

直接问助手：「我还剩多少流量？」「给我一个德国代理」「用美国出口抓一下这个页面并总结」。

Playwright 与 browser-use 的用法见英文版 README：把 `get_dynamic_proxy` 返回的 host、port、用户名、密码填入浏览器的 proxy 配置即可。`fetch_url` 不执行 JavaScript，重度前端渲染的网站请把代理交给浏览器。

## 配置

- `PROXY302_API_KEY`：必填，`<key id>:<secret>`
- `PROXY302_API_SECRET`：可选
- `PROXY302_BASE_URL`：可选，默认 `https://proxy302.com`

密钥只从环境变量读取，不要提交到仓库。

## 许可证

MIT
