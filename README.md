# unfortunately.

一个公开的个人求职记录本。访客看到匿名投递明细与状态统计；管理员通过邮箱验证码登录后维护记录。

## 使用

- 点击「管理登录」，输入配置的管理员邮箱，获取并输入六位验证码。
- 新增投递，填写公司、岗位、类型、日期、状态和备注。公司与备注仅管理员可见；岗位为公开文本。
- 只有当前状态为「已婉拒」的记录计入被拒次数；「暂无回复」不会自动算作被拒。
- 同一条记录最多计一次。改回其他状态或删除后自动重算，历史计数不累加。
- 手机与电脑读取同一份云端数据，每 30 秒及重新切回页面时刷新；修改冲突会提示重新加载。
- 管理页可以导出全部记录为 CSV。文件含私人字段，请自行妥善保存。

## 本地开发

Node.js 22。`npm ci`，复制 `.env.example` 为 `.env`，设置管理员邮箱及随机 `SESSION_SECRET`，然后 `npm run build && npm start`。

开发前端运行 `npm run dev`，另一个终端运行 `npm run dev:server`。开发时 `.env` 的 `APP_ORIGIN` 设置为 Vite 的完整 origin（通常 `http://127.0.0.1:5173`）。

SMTP 使用 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER` 和 `SMTP_PASS`。也可用 `SMTP_PASS_FILE` 指向仓库外权限 600 的授权码文件。QQ 邮箱使用 smtp.qq.com、465、邮箱授权码。不要使用邮箱登录密码，不要提交密钥或数据库到 Git。

## 验证

`npm run check` 运行真实 SQLite + HTTP 测试、TypeScript 检查及生产构建。测试包括公开字段隔离、未登录写入、验证码单次使用/有效期/失败次数/限流、CSRF、日期校验、统计纠正、编辑冲突、重启持久化及 Cookie 标志。

`node tests/preview-server.js` 可启动完全隔离的本地 UI 测试服务（端口 3211，内存数据库）。此服务仅用于开发验证，绝不能部署运行；模拟邮件写入仓库外临时文件。`QA_SEED=1` 可加入明确的虚构样例。正式入口只有 `server/index.js`，无测试登录通道，真实数据从零开始。

## 部署

React + Vite 前端；Express + SQLite 服务；Nginx 提供 HTTPS；systemd 保持后台运行。应用只监听 127.0.0.1:3210，数据库不在静态目录下。

必须先本地 `npm run check` 并验证浏览器，再推送 GitHub，随后部署该精确提交。在 `/opt/apps/unfortunately/releases/<commit>` 解包该提交，配置仓库外 `/opt/apps/unfortunately/shared/runtime.env` 与 `shared/smtp-auth-code.txt`，运行 `bash deploy/install-release.sh`。`runtime.env` 至少配置：

```
NODE_ENV=production
PORT=3210
HOST=127.0.0.1
APP_ORIGIN=https://unfortunately.dkz12345.com
ADMIN_EMAIL=<administrator email>
SESSION_SECRET=<cryptographically random secret>
DATABASE_PATH=/opt/apps/unfortunately/shared/data/unfortunately.sqlite
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=<sender email>
SMTP_PASS_FILE=/opt/apps/unfortunately/shared/smtp-auth-code.txt
MAIL_FROM=<sender email>
APP_REVISION=<exact Git commit>
```

配置与授权码权限 600，数据目录 700。安装脚本先备份 Nginx 配置和已有数据库，再切换独立应用服务及子域名。首次证书签发使用服务器现有 Certbot 账户。

每天执行 SQLite 在线一致性备份，保留最近 14 份于 `shared/data/backups`。这是同机备份，服务器整体丢失仍需异地备份或管理员 CSV 导出。恢复：先停止应用，安全备份当前数据库，删除旧 WAL/SHM 文件并用备份替换主数据库，再启动服务。

回滚应用：把 `current` 符号链接切回上一个 release，更新 `APP_REVISION`，重启 `unfortunately.service`；数据库保持在 shared 中。接口 `/api/health` 返回当前提交，用于确认线上运行版本。故障查看 `journalctl -u unfortunately`；不要输出环境文件或授权码。

## API

- `GET /api/public/applications`：公开白名单字段、全局状态统计、最后更新时间；无公司与备注。
- `GET /api/session`：是否为已登录管理员。
- `POST /api/auth/request-code` / `verify` / `logout`：邮箱验证码与会话。
- `GET/POST /api/admin/applications`、`PUT/DELETE /api/admin/applications/:id`：管理员读写；修改和删除必须携带当前 `version`。
- 写请求必须为同源 JSON；未登录用户无写权限。
