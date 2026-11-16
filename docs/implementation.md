# 实施记录

以用户提供的《DSH-QQ-163 邮件助手完整方案》为规格。目标主机是 Ubuntu 24.04 x86_64。当前阶段先完成可离线验收的系统，真实连接及连续运行由本机部署配置决定。

1. 固定 Node 24、DSH 0.2.2-rc.1、QQ 0.5.5、QQ SDK 1.0.5、dsh-email 0.25.0；验证专用 Web profile 实际加载。
2. `migrations/001.sql`、`src/store.ts` 和 `src/mail.ts`。测试 UID 基线、250 封分页、重复 UID、原子提交、UIDVALIDITY 和 MIME 提取。
3. `src/model.ts` 和 `src/assistant.ts`。模型使用 DSH 的独立无工具调用。验证没有工具、分块保真、调用失败可恢复、主动通知独立账本。
4. `src/conversation.ts`。QQ 所有者核验、编号和引用、草稿版本、预览、SMTP 原子认领和恢复。测试拒绝、重复体、过期、不同聊天、旧版本、重启和部分接受。
5. `src/index.ts`、`scripts/` 和 `deploy/`。QQ 固定包补丁使用官方 SDK 的同一个实例，将入站消息交给确定性 QQ 命令处理器。保留单连接，禁用 QQ 通用聊天。配置样例、systemd、备份升级手册和离线验收结果。
6. P0 实号测试和 P4 48 小时试运行需要 163 客户端授权码、QQ 机器人凭据和所有者 OpenID、模型凭据、指定测试邮件收件地址和内容。
