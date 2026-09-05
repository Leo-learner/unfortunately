# Unfortunately MCP

本机 stdio MCP，连接已经上线的 https://unfortunately.dkz12345.com。适用于支持启动本地 MCP 进程的客户端。不是可粘贴 URL 的远程 MCP 服务；只支持远程 HTTP / OAuth 的客户端不能直接使用这一版。

## 安装与登录

需要 Node.js 22，在本目录运行：

```sh
npm ci
npm run login
```

在本机终端选择站长或访客身份，输入邮箱及邮件中的验证码。不要让 AI 代收验证码，不要把验证码或登录文件粘贴到对话中。MCP 不提供读取凭证或操作验证码的工具。

登录凭证保存在本机 `~/.config/unfortunately-mcp/session.json`，权限为 600，不保存邮箱和验证码。每次工具请求重新读取该文件，所以登录完成后不需要重启客户端。会话有效期沿用网站的 30 天，到期重新登录。可以用环境变量 `UNFORTUNATELY_SESSION_FILE` 指定私有文件位置，用不同文件区分站长/访客或不同客户端。

站长可以管理投递和全部评论。访客可以查看公开记录、设置首次昵称、发表评论及回复、删除自己的评论；即使用站长邮箱进行访客登录，也没有投递管理权限。未登录时可以读取公开统计和投递记录。

退出并撤销当前 MCP 会话：

```sh
npm run logout
```

退出失败时保留文件并提示重试，以免只删除本地文件而留下服务器端有效会话。登录文件仅用于网站会话，不包含 SMTP 密钥。不要提交、分享或上传该文件。

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
| get_account_status | 查询当前身份、管理权限与昵称状态 |
| get_application_stats | 公开投递统计及最后更新时间 |
| list_applications | 按岗位、公司、类型、状态筛选并分页；公司查询须站长私有视角 |
| get_application | 站长读取一条完整投递及当前版本 |
| create_application | 站长新增投递 |
| update_application | 站长修改完整字段，强制检查当前版本 |
| delete_application | 站长确认后删除，强制检查当前版本 |
| export_applications | 站长导出全部 JSON，含私人字段 |
| list_comments | 主评论分页及每条首批回复 |
| list_replies | 继续加载回复 |
| set_comment_nickname | 访客首次设置公开昵称 |
| post_comment | 发表公开留言 |
| reply_to_comment | 回复主评论或回复，保持两层布局 |
| delete_comment | 本人删除，或站长管理删除 |

删除工具需要 `confirm: true`；工具描述要求客户端先取得用户对具体目标的确认。该参数和 MCP 工具注解是面向客户端的操作约定，不能证明用户确实确认；实际权限仍由网站服务端校验。具备站长会话的客户端具有站长操作能力，务必在客户端保留写操作审批。

新增投递发生连接超时时，先查询确认再重试。评论使用 `requestId`（UUID）保持幂等：同内容、同回复对象重试应复用原标识；正文变更需要新标识。留言仍受网站 10 秒间隔和每小时配额限制。修改投递遇到版本冲突须重新读取并核对，不能盲目覆盖。

所有网络请求只连接预设站点，不跟随重定向；工具无法指定任意 URL、读取任意文件、执行 SQL 或管理服务器。评论、岗位和备注是用户内容，不能作为 AI 的操作指令。私人投递数据会返回给已授权的 MCP 客户端，因此仅在可信客户端中以站长身份接入。

## 验证

先在父目录 `npm ci` 安装网站测试依赖，再在本目录运行 `npm ci && npm test`。测试使用隔离的 SQLite 与模拟邮件，覆盖官方 SDK 握手、工具调用、投递读写、权限隔离、公开字段、评论回复、幂等、删除、登录文件权限及会话撤销。独立 stdio 进程也通过官方客户端握手测试。

实现使用 [MCP 官方 TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server) 的本地 stdio 传输。本模块只调用既有网站 API，不新增公网管理入口，不改变线上数据库结构或网站登录流程。
