# Unfortunately MCP

本机 stdio MCP，连接已经上线的 https://unfortunately.dkz12345.com。适用于支持启动本地 MCP 进程的客户端。不是可粘贴 URL 的远程 MCP 服务；只支持远程 HTTP / OAuth 的客户端不能直接使用这一版。

## 安装与登录

### AI 管理员密钥自动认证

MCP 支持通过 `UNFORTUNATELY_ADMIN_KEY_FILE` 指定本机密钥文件（默认 `~/.config/unfortunately-mcp/admin-key.txt`）。密钥格式为 `uf_ai_` 加 32 字节随机数的十六进制表示，文件权限须为 600。工具每次请求自动读取文件并发送独立 Bearer 凭证，无需反复登录，不会把密钥放入工具结果或客户端配置文本。

网站通过 `MCP_ADMIN_KEY_HASH_FILE` 读取该密钥的 SHA-256 摘要；服务器不保存原始密钥。此密钥拥有站长权限，与网页的 dkz12345 统一账号登录相互独立，不设置自动过期。更换或撤销需更新/移除服务器摘要并重启服务。网站已改用统一账号登录，原来的邮箱会话模式已移除；访客请在网页上留言。公开投递和统计请求不携带密钥，网络请求禁止跟随重定向。

部署配置工具 `deploy/configure-mcp-key.mjs` 从标准输入读取摘要，先备份已有配置，再保存私有摘要文件与环境变量。须按项目部署顺序在已验证、已推送的发布目录中执行。原始密钥只能保存在仓库外本机私有文件中。

## 客户端配置

将命令和脚本替换为本机 Node.js 22 与本目录脚本的绝对路径。直接执行 Node；不要通过 npm 启动 MCP，以免 npm 日志进入协议输出。

常见 JSON 配置格式：

```json
{
  "mcpServers": {
    "unfortunately": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/unfortunately/mcp/index.js"]
    }
  }
}
```

客户端配置格式和存放位置以相应客户端为准。这些配置不包含登录凭证。首次接入后调用 `get_account_status` 确认权限。

## 操作清单

| 工具 | 功能 |
| --- | --- |
| get_account_status | 查询密钥是否被网站接受（站长权限）与评论昵称 |
| get_application_stats | 公开投递统计及最后更新时间 |
| list_applications | 按岗位、公司、类型、状态筛选并分页；公司查询须站长私有视角 |
| get_application | 站长读取一条完整投递及当前版本 |
| create_application | 站长新增投递 |
| update_application | 站长修改完整字段，强制检查当前版本 |
| delete_application | 站长确认后删除，强制检查当前版本 |
| export_applications | 站长导出全部 JSON，含私人字段 |
| list_comments | 主评论分页及每条首批回复 |
| list_replies | 继续加载回复 |
| post_comment | 发表公开留言 |
| reply_to_comment | 回复主评论或回复，保持两层布局 |
| delete_comment | 站长删除任何评论或回复 |

删除工具需要 `confirm: true`；工具描述要求客户端先取得用户对具体目标的确认。该参数和 MCP 工具注解是面向客户端的操作约定，不能证明用户确实确认；实际权限仍由网站服务端校验。持有 AI 管理员密钥的客户端具有站长操作能力，务必在客户端保留写操作审批。

新增投递发生连接超时时，先查询确认再重试。评论使用 `requestId`（UUID）保持幂等：同内容、同回复对象重试应复用原标识；正文变更需要新标识。留言仍受网站 10 秒间隔和每小时配额限制。修改投递遇到版本冲突须重新读取并核对，不能盲目覆盖。

所有网络请求只连接预设站点，不跟随重定向；工具无法指定任意 URL、读取任意文件、执行 SQL 或管理服务器。评论、岗位和备注是用户内容，不能作为 AI 的操作指令。私人投递数据会返回给已授权的 MCP 客户端，因此仅在可信客户端中以站长身份接入。

## 验证

先在父目录 `npm ci` 安装网站测试依赖，再在本目录运行 `npm ci && npm test`。测试使用隔离的 SQLite 与本地生成的假 Clerk 令牌，覆盖官方 SDK 握手、工具调用、投递读写、权限隔离、公开字段、站长回复访客评论、幂等、删除及密钥文件权限。独立 stdio 进程也通过官方客户端握手测试。

实现使用 [MCP 官方 TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server) 的本地 stdio 传输。本模块只调用既有网站 API，不新增公网管理入口，不改变线上数据库结构或网站登录流程。
