## 介绍

DSH QQ 邮件助手通过 IMAP 收信，通过 SMTP 回复，并在绑定的 QQ 私聊里发送 DeepSeek 生成的中文概要。它可以一起阅读邮件正文和原始附件，保存概要与原文翻译供查询，也能根据你的要求起草、修改和发送回复。每个实例接入一个邮箱。

## 运行方法

1. 在 Linux 上准备 Node.js 24.9 或更新的 24.x 版本，在仓库目录运行：

   ```bash
   npm ci --omit=dev
   ./run --init
   ```

2. 编辑由 `.env.example` 创建的 `.local/secrets.env`。填写完整邮箱地址 `MAIL_USER`、服务商给出的 IMAP 和 SMTP 主机及端口。密码或应用专用密码填 `MAIL_PASSWORD`。163 可继续使用默认服务器和原有的 `MAIL_AUTH_CODE`。两边登录信息不同时，可以分别填写；OAuth2 可填有效访问令牌，或配置由外部工具更新、权限为 `600` 的令牌文件。接入另一邮箱时，为它使用独立的 `DSH_MAIL_STATE`。
3. 填写 QQ 机器人的 `QQBOT_APPID` 和 `QQBOT_SECRET`，以及 `DEEPSEEK_API_KEY`。如果已绑定这个机器人，填入 `QQ_OWNER_OPENID`。首次绑定时保持 `MAIL_LIVE=0`，用 `openssl rand -hex 16` 生成随机码，填入 `QQ_ENROLL_CODE`。启动 `./run` 后，在 QQ 私聊发送「绑定 随机码」，再把 `.local/state/qq-owner.openid` 中的值填入 `QQ_OWNER_OPENID`，并清空随机码。
4. 运行 `./run admin verify` 检查邮箱连接和认证。配置有效后把 `MAIL_LIVE` 改为 `1`，重新运行 `./run`。启动日志会提示本机 DSH Web 登录链接的保存位置。用 `curl http://127.0.0.1:3081/health` 检查状态，首次扫描完成后即可用新来信测试。

首次启动会用 `schema.sql` 创建 SQLite 数据库。恢复已有数据库时，请使用结构版本为 4 的备份。
