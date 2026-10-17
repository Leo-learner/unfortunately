# unfortunately.

一个公开的个人求职记录本。访客看到匿名投递明细与状态统计；站长用 dkz12345 统一账号（Clerk）登录后维护记录。

## 使用

- 点击「管理登录」，在 accounts.dkz12345.com 用站长的统一账号登录。站长账号须开启两步验证，登录和两步验证都须在 12 小时内完成，否则提示重新登录。
- 新增投递，填写公司、岗位、类型、日期、状态和备注。公司与备注仅管理员可见；岗位为公开文本。
- 只有当前状态为「已婉拒」的记录计入被拒次数；「暂无回复」不会自动算作被拒。
- 同一条记录最多计一次。改回其他状态或删除后自动重算，历史计数不累加。
- 手机与电脑读取同一份云端数据，每 30 秒及重新切回页面时刷新；修改冲突会提示重新加载。
- 管理页可以导出全部记录为 CSV。文件含私人字段，请自行妥善保存。

## 本地开发

Node.js 22。`npm ci`，复制 `.env.example` 为 `.env`，设置站长邮箱、随机 `SESSION_SECRET` 和 Clerk 三项（`CLERK_PUBLISHABLE_KEY`、`CLERK_JWT_KEY_FILE`、`OWNER_CLERK_USER_ID`），然后 `npm run build && npm start`。

开发前端运行 `npm run dev`，另一个终端运行 `npm run dev:server`。开发时 `.env` 的 `APP_ORIGIN` 设置为 Vite 的完整 origin（通常 `http://127.0.0.1:5173`）。

登录统一由 Clerk 托管，本站不发邮件、不存密码。服务器只放 publishable key 和实例的 JWT 公钥，用来在本地验证 `Authorization: Bearer` 中的会话令牌；Clerk 私钥（sk_live）不放在服务器上。不要提交数据库到 Git。

## 验证

`npm run check` 运行真实 SQLite + HTTP 测试、TypeScript 检查及生产构建。测试使用本地生成的假 Clerk 令牌，包括公开字段隔离、未登录写入、站长/非站长/会话过旧/缺第二因子、伪造与过期令牌、只认 Bearer、CSRF、日期校验、统计纠正、编辑冲突、重启持久化、旧访客按邮箱接管及 CSP。

`node tests/preview-server.js` 可启动完全隔离的本地 UI 测试服务（端口 3211，内存数据库）。此服务仅用于开发验证，绝不能部署运行；使用一次性的测试签名密钥，线上 Clerk 不认本地地址。`QA_SEED=1` 可加入明确的虚构样例。正式入口只有 `server/index.js`，无测试登录通道，真实数据从零开始。

## 部署

React + Vite 前端；Express + SQLite 服务；Nginx 提供 HTTPS；systemd 保持后台运行。应用只监听 127.0.0.1:3210，数据库不在静态目录下。

必须先本地 `npm run check` 并验证浏览器，再推送 GitHub，随后部署该精确提交。在 `/opt/apps/unfortunately/releases/<commit>` 解包该提交，配置仓库外 `/opt/apps/unfortunately/shared/runtime.env`，运行 `bash deploy/install-release.sh`。`runtime.env` 至少配置：

```
NODE_ENV=production
PORT=3210
HOST=127.0.0.1
APP_ORIGIN=https://unfortunately.dkz12345.com
ADMIN_EMAIL=<administrator email>
SESSION_SECRET=<cryptographically random secret>
DATABASE_PATH=/opt/apps/unfortunately/shared/data/unfortunately.sqlite
CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuZGt6MTIzNDUuY29tJA
CLERK_JWT_KEY_FILE=/opt/apps/unfortunately/current/deploy/clerk-dkz12345.pem
OWNER_CLERK_USER_ID=<owner Clerk user id>
APP_REVISION=<exact Git commit>
```

配置权限 600，数据目录 700。安装脚本先备份 Nginx 配置和已有数据库，再切换独立应用服务及子域名。首次证书签发使用服务器现有 Certbot 账户。

每天执行 SQLite 在线一致性备份，保留最近 14 份于 `shared/data/backups`。这是同机备份，服务器整体丢失仍需异地备份或管理员 CSV 导出。恢复：先停止应用，安全备份当前数据库，删除旧 WAL/SHM 文件并用备份替换主数据库，再启动服务。

回滚应用：把 `current` 符号链接切回上一个 release，更新 `APP_REVISION`，重启 `unfortunately.service`；数据库保持在 shared 中。接口 `/api/health` 返回当前提交，用于确认线上运行版本。故障查看 `journalctl -u unfortunately`；不要输出环境文件或授权码。

## API

- `GET /api/public/applications`：公开白名单字段、全局状态统计、最后更新时间；无公司与备注。
- `GET /api/session`：`authenticated` 是否为站长，`access` 为 `owner`、`signed-out`、`reauth-required`（站长但会话过旧或缺第二因子）或 `not-owner`。
- 登录与退出在 accounts.dkz12345.com 完成；请求携带 Clerk 会话令牌 `Authorization: Bearer`，不认 cookie。管理接口未登录返回 401，其他账号返回 403 `NOT_OWNER`，会话不满足要求返回 403 `REAUTH_REQUIRED`。
- `GET/POST /api/admin/applications`、`PUT/DELETE /api/admin/applications/:id`：管理员读写；修改和删除必须携带当前 `version`。
- 写请求必须为同源 JSON；未登录用户无写权限。


## 留言区

留言区位于投递列表下方。访客用任意 dkz12345 统一账号登录，首次填写公开昵称后即可留言、回复以及删除自己的评论。昵称 1–24 字，留言 1–2000 字；只显示纯文本。评论不可编辑。站长账号以「站长」身份评论；会话满足管理要求时还可删除任何评论。站长身份由服务端按 Clerk 用户 id 判断，与邮箱无关。

主评论按最新排序，每页 10 条。回复统一放在主评论下，按发布时间正序排列，每批加载 10 条，并标明回复对象。删除评论会清空正文；存在有效回复时保留已删除占位，无讨论的已删除评论不再展示。

邮箱从不出现在公开评论响应中。以前用邮箱验证码登录的访客，第一次用相同邮箱的统一账号登录时自动接管原来的昵称和评论（Clerk 的主邮箱都是验证过的）；之后这个评论身份只认该 Clerk 账号。邮箱已被接管、没有邮箱或与站长邮箱相同的账号会得到新的评论身份，不会继承「站长」。发言同账号间隔至少 10 秒、每小时 30 条，同 IP 每小时 60 条。发言配额保存于数据库，服务重启不会清空；限流使用 IP 的 HMAC 值而非额外存储明文 IP。

新增接口：

- `GET /api/comments/session`：当前评论身份。
- `PUT /api/comments/profile`：首次设置公开昵称。
- `GET /api/comments?page=1`：主评论分页及每条首批回复，公开白名单字段，登录用户可见权限布尔值。
- `GET /api/comments/:id/replies?after=0`：主评论下按 ID 正序加载更多回复。
- `POST /api/comments`：纯文本正文、可选回复目标和防重复提交的 UUID clientKey。
- `DELETE /api/comments/:id`：作者本人或管理员可删除，所有判断在服务端执行。

新增表采用增量创建，不修改原有投递表与会话。每日 SQLite 备份自动包含访客账号、评论与回复。部署时先备份数据库和运行配置，再更新精确版本号与 current 链接；回滚恢复原链接及备份的 runtime.env，新表可保留以避免丢失评论。

## AI / MCP 接入

`mcp/` 提供独立本机 stdio MCP，包含投递增删改查、导出、统计和评论回复等 13 项操作。通过本机私有文件中的独立 AI 管理员密钥以站长身份操作；服务器只保存密钥摘要，AI 工具不暴露密钥。访客请在网页上用统一账号留言。安装、登录和接入说明见 [MCP README](mcp/README.md)。该模块不增加远程 MCP URL，也不改变数据库结构。
