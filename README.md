# DSH QQ 163 邮件助手

单账号 163 邮箱，单个 QQ 官方机器人，只处理绑定所有者的私聊。本机的独立 DSH Web profile 提供模型配置和邮件工作台。

这台机器已安装并启用 `dsh-mail.service`，已完成 QQ 所有者绑定并建立新邮件收件基线。维护配置时使用 `sudoedit /etc/dsh-mail/secrets.env`，保存后执行 `sudo systemctl restart dsh-mail.service`。以下本机启动说明适用于开发测试，使用相同端口前先停止系统服务。

## 本机启动

进入本项目目录后运行 `./run`。本机已有 Node 24.22.2。若从源码重新构建，把 Node 24 的 bin 放入 PATH，再运行 `npm ci`、`npm run build`、`npm test`。

`./run --init` 创建权限为 600 的 `.local/secrets.env`。重复执行会保留现有内容。默认 `MAIL_LIVE=0`，此时可以启动 Web 和检查配置。DSH 登录地址保存在 `.local/state/web.url`，用本机浏览器打开文件中的地址。地址含短期登录凭据。健康检查使用 `http://127.0.0.1:3081/health`。

### 真实联调

1. 在 163 网页设置启用 IMAP/SMTP，生成客户端授权码。填写 `MAIL_USER` 和 `MAIL_AUTH_CODE`。运行 `./run admin verify` 验证 IMAP 登录、SMTP 认证和 Sent 目录声明。这个命令不投递测试邮件。
2. 在 QQ 机器人管理端取得 AppID 和 AppSecret，填写 `QQBOT_APPID` 和 `QQBOT_SECRET`。若已有这个机器人的所有者 OpenID，直接填 `QQ_OWNER_OPENID`。否则在终端执行 `openssl rand -hex 16`，将输出填入 `QQ_ENROLL_CODE`。保持 `MAIL_LIVE=0` 和空的 `QQ_OWNER_OPENID`，重启后由你的 QQ 私聊向机器人发送「绑定 随机码」，两个字段中间是空格。收到成功回复后，从 `.local/state/qq-owner.openid` 读取 OpenID 并填入。系统部署改用 `sudo cat /var/lib/dsh-mail/state/qq-owner.openid`。清除 `QQ_ENROLL_CODE`，再重启。更换机器人或所有者时使用独立数据库。
3. 使用 DeepSeek API 可在本地填写 `DEEPSEEK_API_KEY`，默认路由取自这个 DSH Web profile 的当前默认模型。也可在独立 Web profile 中配置其他 DSH 支持的模型。翻译和回复生成会把所选邮件的正文交给该模型服务。默认每天最多 1,000 次模型请求，可用 `DSH_MAIL_MODEL_CALLS_DAILY` 修改。
4. QQ 客户端允许机器人主动发消息。完成服务器配置时将 `MAIL_LIVE` 改为 `1` 并重启。首次扫描只记录 INBOX 的当前 UID 边界。部分 163 服务器不返回 UIDNEXT，服务会只读查询最后一封仍在 INBOX 的邮件的 UID。之后沿用已经记录的最高 UID。等健康页显示一次成功扫描后，再从指定测试邮箱向 163 发入测试邮件。邀请机器人之前确认测试邮箱及回复内容，阅完预览后在 QQ 私聊确认。
5. 用实际发信结果确认是否需要独立保存 Sent 副本。仅在确认 163 无自动副本后，填写已实测的 `MAIL_SENT_FOLDER`。后续 SMTP 已接受结果与 IMAP 副本使用分开的记录。

### QQ 对话

可以直接说「看看刚到的那封邮件」「帮我用英文回复这封，就说我能参加」「把刚才那份草稿改得客气一点」。助手可根据最近邮件的主题、发件人、引用和当前草稿判断目标。指向不清楚时会请你选择编号。下面这些快捷指令仍可直接使用。

回复所引用的 QQ 通知时使用该通知对应的邮件，直接指定邮件编号也可定位。新通知送达后可成为当前来信。草稿预览首行标出来源邮件的编号和主题。修改草稿会显示新版本的预览，确认对应版本后进入发送队列。

新邮件的 QQ 通知由 DeepSeek 直接生成 Markdown。首行显示以下一个分类，后面是邮件主题，以及概要、待办、附件、助手建议四部分。附件部分按来信顺序为每份附件单列一条概要。紧急表示需要你处理且有明确时间压力或拖延后果。

- 【需要操作 · 紧急】
- 【需要操作 · 不紧急】
- 【无需操作】

| 指令 | 用途 |
| --- | --- |
| 收件箱、状态 | 最近邮件、扫描与投递状态 |
| 详情 M1、概要 M1、译文 M1、原文 M1 | 按需查看已保存的 Markdown 概要、完整译文或原文 |
| 改概要 M1：把时限写清楚、改译文 M1：统一术语 | 也可用自然语言提出要求。改写成功后保存对应字段，之后的查询直接读取新版 |
| 附件 M1 1 | 在 QQ 私聊获取 M1 的第 1 个原始附件 |
| 回复 M1：请告知下周有空 | 根据来信与要求起草，也可以要求原样使用你给出的正文 |
| 回复所有人 M1：谢谢 | 展开有效的原 To/Cc 并去重 |
| 修改 D1：请更委婉 | 生成新版本，更新预览 |
| 预览 D1 | 展示完整正文、收件人、版本和快照哈希 |
| 发送 D1 v2、就这样发吧 | 确认发送当前预览版本。明确要求直接发出新回复时，也可以在同一条消息里授权发送 |
| 取消 D1、忽略 M1、重试 M1 | 取消未提交草稿、忽略本地显示、重新排队分析 |
| 暂停通知、恢复通知 | 控制 QQ 主动通知，积压较多时合并编号 |

主动通知只推送概要。可在 QQ 说「给我看这封邮件的全文」按需查看。概要、详情、全文与草稿预览保留完整内容，在一条消息中送达。QQ 平台允许时使用原生 Markdown。QQ 拒绝 Markdown 时尝试纯文本，QQ 明确拒绝消息长度时用一份 TXT 传送完整内容。发送回执中的「163 已接受」表示 SMTP 服务器已接收。

## Ubuntu 常驻部署

先停止本机前台实例。使用本地管理员终端运行以下命令，安装前确保 `npm ci`、构建和测试已通过。

```bash
/home/lzc/.nvm/versions/node/v24.22.2/bin/node scripts/release.mjs
sudo bash deploy/install.sh /home/lzc/.nvm/versions/node/v24.22.2/bin/node
sudoedit /etc/dsh-mail/secrets.env
sudo systemctl enable --now dsh-mail.service
systemctl status dsh-mail.service
curl http://127.0.0.1:3081/health
```

系统服务使用独立的 `dshmail` 用户。部署目录包含固定版本运行时、应用和 SHA-256 发布清单。凭据设为 600，由 systemd 读取。正式运行的数据库在 `/var/lib/dsh-mail/state/mail.sqlite`。本机开发数据保存在项目内的 `.local`，建议首次真实联调直接选择计划长期使用的运行方式。切换已有业务数据时先停止两个实例，保留两侧备份，再恢复所选数据库。账号、机器人及所有者绑定必须一致。

系统服务的 DSH 登录地址保存在 `/var/lib/dsh-mail/state/web.url`，由管理员在本机读取。远程使用 `ssh -L 3080:127.0.0.1:3080 <用户名>@<主机>` 建立回环转发。配置模式下如果需要核对登录和 QQ，可以保留 `MAIL_LIVE=0` 后启动服务。

### 维护和恢复

`./run admin backup /绝对路径/mail.sqlite` 可在服务运行时创建 SQLite 一致性快照。备份可能含邮件内容。将备份存入仅管理员可访问的目录，并按需加密。另行备份 DSH profile、发布清单和凭据。默认正文与译文保留 30 天，操作审计保留 180 天。发送账本及结果不明记录继续保留，供重启后核对。

- 启动前核对配置用 `./run admin status`。运行时可查看健康页或 QQ「状态」。扫描超过三个周期无成功、认证失败或 QQ 断线会反映在健康页。
- UIDVALIDITY 变化后保留旧游标并暂停扫描。确认应补扫的起点，停止服务，备份，然后执行 `./run admin reconcile 2026-11-16T09:00:00+08:00`。程序根据邮箱接收时间及信封信息尝试匹配旧邮件，保持原编号，并保留新发现的邮件。时间值应替换成管理员核对的实际起点。
- QQ 已明确失败的通知，可停服务后使用 `./run admin retry-notice mail/1` 重排。SMTP 或 QQ 结果不明时先人工核对已发邮件、收件箱或 QQ 客户端。
- 独立的 Sent 副本失败可用 `./run admin retry-copy D1 v1` 重排。补存前会按 Message-ID 查找已有副本。
- 升级前暂停创建新发送任务，停止服务并制作备份。以新版本的锁文件重新构建和运行测试，在停机状态执行安装。发现部分切换失败时，安装器会打印旧文件保留路径。将保留目录中的旧应用、Node、依赖、清单和 systemd 单元恢复到各自原路径，再由管理员执行 `systemctl daemon-reload`。如数据库版本已上升，需要兼容的旧版本或经核对的快照。
- 恢复较早数据库前先核对较新发送账本。停止服务并保留当前数据库及 WAL，一致性快照恢复到新目录测试完整性后，再将它置入正式状态目录。先用 `MAIL_LIVE=0` 验证，再启用。若恢复丢失未决发送记录，须先用发件箱和最近回执核对。

系统维护命令使用同一 `scripts/admin.mjs`。管理员可用如下方式进入 systemd 同样的状态路径，并在本机加载凭据。用于暂停或恢复扫描时先停止服务。

```bash
sudo bash -c 'set -a; . /etc/dsh-mail/secrets.env; set +a; export DSH_MAIL_STATE=/var/lib/dsh-mail/state; exec runuser -u dshmail --preserve-environment -- /opt/dsh-mail/runtime/bin/node /opt/dsh-mail/mail-assistant/scripts/admin.mjs "$@"' -- verify
```

## 集成及首版范围

固定 DSH 0.2.2-rc.1、官方 QQ 插件 0.5.5、QQ SDK 1.0.5 和 dsh-email 0.25.0。构建对 QQ 插件两处入口做 SHA-256 校验，并在专用 profile 中启用邮件路由。由官方 SDK 持有唯一 WebSocket 和 REST 连接。QQ 自然语言发信意图由模型复核，发送由草稿版本与持久队列控制。正文分析、翻译和草拟回复走 DSH，无工具调用。dsh-email 可在 Web 管理界面单独配置。

在 DeepSeek 官方 `deepseek-flash` 路由下，服务通过 Files API 上传原始附件，并将已上传的附件与邮件正文一起提交给模型生成 Markdown 概要。PDF、Word 和 PowerPoint 使用可保留图表的版面解析，常见图像和表格也可直接提交。遇到无法读取的附件时，概要会注明原因。服务在分析结束后请求删除临时上传，上传时也设置一小时后过期。支持的格式见 [DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api/)。

正文、附件元数据和 QQ 待投递文本存于受限 SQLite 文件。最终 Markdown 概要与原文翻译独立缓存，已保存的历史译文也可继续查询。通知使用入库的 Markdown，按需查询直接读取当前版本。按需发送原始附件时，服务通过 IMAP 从原邮件获取文件。单封 MIME 上限 24 MiB，正文字节上限 2 MiB，长文按段落翻译。模型请求沿用所选服务的默认输出配置。SMTP 暂时失败提供状态，请核对后重新起草。QQ 限流以主动投递账本统计，真实账户的流量额度需现场验收。
