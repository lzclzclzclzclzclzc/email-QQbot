import { attachmentLines, attachmentSource, safeError, type Assistant } from './assistant.js'
import { authorizes, commandIntent, interpretIntent, isDraftAction, isMailAction, references, type Intent } from './intent.js'
import type { NativeAttachment } from './deepseek-files.js'
import { MailIssue, replyEnvelope } from './mail.js'
import { classificationLabel, replyPrompt } from './model.js'
import type { Draft, Identity, Mail } from './types.js'

type Message = Identity & { scope: string; text: string; quote?: string; quotedText?: string }
type Reply = (text: string, file?: NativeAttachment, nativeMarkdown?: boolean) => Promise<void>
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const label = (draft: Draft) => `D${draft.id} v${draft.version}`
const clean = (text: string, max: number) => [...text].slice(0, max).join('')

export class Conversation {
  constructor(private app: Assistant, private ownerId: string, private account: string) {}
  private get store() { return this.app.store }

  async handle(msg: Message, reply: Reply) {
    if (msg.scope !== 'c2c' || msg.owner !== this.ownerId || msg.chat !== this.ownerId || !msg.event) return
    if (!this.store.rememberEvent(msg.event)) return
    try { await this.route(msg, reply) }
    catch (error) {
      if (!(error instanceof MailIssue)) this.store.audit('conversation', 'owner', safeError(error))
      await reply(error instanceof MailIssue ? error.message : '操作未完成，请发送「状态」查看或用新消息重试。')
    }
  }

  private async route(msg: Message, reply: Reply) {
    const text = msg.text
    const context = this.context(msg)
    const direct = commandIntent(text)
    const explicit = direct?.target ? [direct.target] : references(text.split(/[:：]/, 1)[0])
    let intent = direct
    if (!intent) {
      try { intent = await this.interpret(text, explicit, context) }
      catch (error) {
        this.store.audit('interpret_intent', 'owner', safeError(error))
        return reply('暂时无法理解自然语言。可直接发送「收件箱」「状态」或「详情 M1」。')
      }
      if (explicit.length === 1 && explicit[0].startsWith('M') && isMailAction(intent.action)) intent.target = explicit[0]
      if (explicit.length === 1 && explicit[0].startsWith('D') && isDraftAction(intent.action)) intent.target = explicit[0]
    }
    if (intent.action === 'help' && intent.answer) return reply(intent.answer)
    if (explicit.length > 1 && (!intent.target || intent.action === 'confirm' || intent.action === 'cancel' || intent.sendNow)) {
      return reply('请告诉我这次要处理的是哪一个：' + explicit.join('、'))
    }

    if (intent.action === 'status') {
      const h = this.store.health()
      return reply([
        'QQ 网关 ' + (this.app.qqConnected ? '在线' : '未就绪'),
        '上次收件扫描 ' + (h.lastScan ? date(h.lastScan) : '尚无') + (this.app.scanIssue ? ' · ' + this.app.scanIssue : ''),
        '模型上次成功 ' + (h.lastModel ? date(h.lastModel) : '尚无'),
        `邮件待处理 ${h.pending} · 处理失败 ${h.failed}`,
        `QQ 待通知 ${h.qqPending} · 失败 ${h.qqFailed} · 不明 ${h.qqUnknown}`,
        `SMTP 排队 ${h.smtpWaiting} · 不明 ${h.smtpUnknown} · 部分接受 ${h.smtpPartial} · 副本异常 ${h.sentCopyIssues}`,
        ...(h.reconcile ? ['UIDVALIDITY 已变化，等待本机核对。'] : [])
      ].join('\n'))
    }

    if (intent.action === 'pause_notifications' || intent.action === 'resume_notifications') {
      const paused = intent.action === 'pause_notifications'
      if (paused) this.store.setSetting('notifications_paused', '1')
      else this.store.resumeNotifications()
      return reply(paused ? '已暂停主动通知，收件继续。' : '已恢复主动通知，积压按配额补发。')
    }
    if (intent.action === 'recent') {
      const mails = this.store.recent(intent.limit)
      return reply(mails.length ? mails.map(mail =>
        `M${mail.id} · ${mail.translation?.subject || mail.subject} · ${mail.status}` +
        (mail.translation?.points[0] ? '\n  ' + mail.translation.points[0] : '')).join('\n') : '助手账本暂无新邮件。')
    }
    if (isDraftAction(intent.action)) {
      const fallback = context.quotedDraft ?? context.currentDraft
      const referencedMail = explicit.find(ref => ref.startsWith('M')) ?? context.quotedMail
      let id = intent.target ?? fallback
      if (intent.action === 'confirm') {
        id = explicit.find(ref => ref.startsWith('D')) ?? context.quotedDraft
        if (!id && referencedMail) {
          const drafts = this.store.draftsForMail(Number(referencedMail.slice(1)))
          if (drafts.length === 1) id = 'D' + drafts[0].id
        } else if (!id) id = fallback
      }
      if (!id) return reply('请告诉我你指哪份草稿，例如「刚才的回复」或「D27」。')
      if (intent.action === 'confirm' && intent.target && intent.target !== id)
        return reply('我找到了不同的草稿，请告诉我你要发送哪一份。')
      const draft = this.store.latestDraft(Number(id.slice(1)))
      if (!draft) return reply('这份草稿不存在。')
      if (!explicit.includes(id) && referencedMail && 'M' + draft.mail !== referencedMail)
        return reply('当前草稿对应另一封邮件。请告诉我你想处理哪份草稿。')
      const version = intent.version ?? (id === context.quotedDraft ? context.quotedVersion : undefined)
      if (version && version !== draft.version) return reply('当前草稿版本为 ' + label(draft) + '。')
      if (intent.action === 'cancel') {
        if (!direct && !await authorizes(this.app.model, text, 'cancel'))
          return reply('这份草稿还在。你是想查看状态，还是撤回发送？')
        return reply(this.store.cancel(draft) ? `${label(draft)} 已取消。` : '草稿当前无法取消。')
      }
      if (intent.action === 'draft_status' || !this.store.editable(draft)) return reply(`${label(draft)} · ${draft.state}`)
      if (intent.action === 'preview') return this.preview(draft, msg, reply)
      if (intent.action === 'confirm') {
        if (!direct && !await authorizes(this.app.model, text, 'confirm'))
          return reply('这份草稿还在。你是想发送，还是再修改一下？')
        if (this.store.approve(draft, msg, Date.now())) return reply(`${label(draft)} 已确认并排队。`)
        if (this.store.hasPreview(draft, msg)) return reply(`这条消息早于 ${label(draft)} 的预览。请另发一条消息确认。`)
        return this.preview(draft, msg, reply)
      }
      const mail = this.store.mail(draft.mail)
      const revised = intent.body ?? await this.generate({ request: text, original: mail?.body?.text,
        language: mail?.translation?.language, draft: draft.payload.text })
      const updated = this.store.reviseDraft(draft, { ...draft.payload, text: revised })
      return this.preview(updated, msg, reply)
    }

    if (isMailAction(intent.action)) {
      const mails = this.store.recent(5)
      const viewOrEdit = ['details', 'translation', 'revise_overview', 'revise_translation'].includes(intent.action)
      const quoted = explicit.some(ref => ref.startsWith('M')) ? undefined : context.quotedMail
      const id = quoted ?? intent.target ?? (direct || viewOrEdit || intent.action === 'reply' ? context.currentMail ??
        (mails.length === 1 ? 'M' + mails[0].id : undefined) : undefined)
      if (!id) return reply(mails.length ? '你指哪封邮件？最近的编号是 ' + mails.map(mail => 'M' + mail.id).join('、') + '。' : '暂无可选择的邮件。')
      const mail = this.store.mail(Number(id.slice(1)))
      if (!mail) return reply('邮件不存在。')
      this.store.selectMail(mail.id, msg.receivedAt ?? Date.now())
      return this.handleMail(intent, mail, msg, text, reply)
    }

    return reply('你可以直接告诉我想怎么处理邮件，或问我目前的草稿和发送状态。')
  }

  private context(msg: Message) {
    const selectedMail = Number(this.store.getSetting('selected_mail'))
    const selectedAt = Number(this.store.getSetting('selected_mail_at') ?? 0)
    const notice = this.store.latestDeliveredMail()
    const currentMail = notice && (!selectedMail || notice.touched > selectedAt) ? notice.id : selectedMail
    const currentDraft = Number(this.store.getSetting('selected_draft'))
    const ledger = msg.quote ? this.store.quoted(msg.quote) : undefined
    const quote = /^(?:(?:\*\*)?【(?:需要操作 · (?:紧急|不紧急)|无需操作)】(?:\*\*)?\s*)?(?:\*\*)?((?:M|D)\d+)(?:\s*[·：:]|\s+v(\d+))/i.exec(msg.quotedText ?? '')
    const quoted = quote?.[1].toUpperCase()
    return {
      currentMail: currentMail ? 'M' + currentMail : undefined,
      quotedMail: ledger ? 'M' + ledger : quoted?.startsWith('M') ? quoted : undefined,
      currentDraft: currentDraft ? 'D' + currentDraft : undefined,
      quotedDraft: quoted?.startsWith('D') ? quoted : undefined,
      quotedVersion: quote?.[2] ? Number(quote[2]) : undefined
    }
  }

  private async interpret(text: string, explicit: string[], context: ReturnType<Conversation['context']>) {
    const mails = new Map(this.store.recent(8).map(mail => ['M' + mail.id, mail]))
    for (const id of [...explicit, context.quotedMail, context.currentMail]) {
      if (!id?.startsWith('M') || mails.has(id)) continue
      const mail = this.store.mail(Number(id.slice(1)))
      if (mail) mails.set(id, mail)
    }
    const drafts = new Map<string, Draft>()
    for (const ref of [...explicit, context.quotedMail]) {
      if (!ref?.startsWith('M')) continue
      for (const draft of this.store.draftsForMail(Number(ref.slice(1)))) drafts.set('D' + draft.id, draft)
    }
    for (const id of [...explicit, context.quotedDraft, context.currentDraft]) {
      if (!id?.startsWith('D')) continue
      const draft = this.store.latestDraft(Number(id.slice(1)))
      if (draft) drafts.set(id, draft)
    }
    return interpretIntent(this.app.model, text, {
      context,
      mails: [...mails].map(([id, mail]) => ({ id, subject: clean(mail.translation?.subject && mail.translation.subject !== mail.subject
        ? mail.subject + ' / ' + mail.translation.subject : mail.subject, 180), from: mail.from[0],
        files: mail.body?.attachments.map(file => clean(file.name, 140)) })),
      drafts: [...drafts].map(([id, draft]) => ({ id, mail: 'M' + draft.mail, version: draft.version, status: draft.state }))
    })
  }

  private async handleMail(intent: Intent, mail: Mail, msg: Message, text: string, reply: Reply) {
    switch (intent.action) {
      case 'ignore':
        this.store.ignore(mail.id)
        return reply(`M${mail.id} 已在助手中忽略。`)
      case 'retry':
        return reply(this.store.retryMail(mail.id) ? '已重新排队。' : '邮件当前无法重新排队。')
      case 'details':
        if (mail.summaryMarkdown) return reply(mail.summaryMarkdown, undefined, true)
        return this.deliverText(mail, '详情', this.details(mail), reply, mail.translation && classificationLabel(mail.translation))
      case 'revise_overview':
        return reply(await this.app.reviseOverview(mail, text), undefined, true)
      case 'original':
        return this.deliverText(mail, '原文', (await this.app.read(mail)).text, reply)
      case 'attachment': {
        const body = await this.app.read(mail)
        if (!body.attachments.length) return reply(`M${mail.id} 没有附件。`)
        const requested = intent.file ?? (body.attachments.length === 1 ? 1 : undefined)
        if (requested === undefined || !body.attachments[requested - 1]) return reply(`请选择要看的附件，发送「附件 M${mail.id} 序号」。\n` +
          body.attachments.map((file, index) => `${index + 1}. ${clean(file.name, 120)}`).join('\n'))
        const attachment = body.attachments[requested - 1]
        const loaded = attachment.data ? body : await this.app.read(mail, true)
        const original = loaded.attachments[requested - 1]
        if (!original?.data) return reply(`${attachment.name} 的原文件暂时无法从邮箱读取。`)
        return reply(`M${mail.id} · ${original.name}`, { name: original.name, type: original.type, data: original.data })
      }
      case 'translation':
        return this.deliverText(mail, '原文翻译', await this.app.originalTranslation(mail), reply)
      case 'revise_translation':
        return this.deliverText(mail, '原文翻译', await this.app.reviseOriginalTranslation(mail, text), reply)
      case 'reply': {
        const body = await this.app.read(mail)
        const drafted = intent.body ?? await this.generate({ request: text, subject: mail.subject, language: mail.translation?.language,
          original: body.text, summary: mail.summaryMarkdown ?? mail.translation?.points })
        const draft = this.store.createDraft(mail.id, replyEnvelope(mail, body, this.account, drafted, intent.replyAll === true))
        return this.finishDraft(draft, intent, msg, reply)
      }
    }
  }

  private async generate(input: unknown) {
    const result = await replyPrompt(this.app.model, input)
    if (!result.trim()) throw new MailIssue('模型未能生成可预览的回复。')
    return result.trim()
  }

  private details(mail: Mail) {
    const result = mail.translation
    const attachments = mail.body?.attachments ?? []
    const notices = this.store.noticesForMail(mail.id).map(row => `${row.state}${row.issue ? '（' + row.issue + '）' : ''}`)
    return [
      mail.subject, '发件人 ' + mail.from.join(', '), '收件 ' + date(mail.received),
      `处理状态 ${mail.status}${mail.issue ? ' · ' + mail.issue : ''}`,
      ...(result?.points ?? []),
      ...(result?.actions ?? []).map(item => (item.basis === 'explicit' ? '对方要求 ' : '建议 ') + item.text + attachmentSource(item.attachment)),
      ...(result?.deadlines ?? []).map(item => '时间 ' + item.raw + (item.normalized ? ' · ' + item.normalized : '') + attachmentSource(item.attachment)),
      ...attachmentLines(attachments, result, true),
      ...(notices.length ? ['QQ 通知 ' + notices.join('、')] : [])
    ].join('\n')
  }
  private deliverText(mail: Mail, title: string, text: string, reply: Reply, prefix?: string | null) {
    return reply((prefix ? prefix + '\n' : '') + `M${mail.id} · ${title}\n${text || '（无正文）'}`)
  }
  private async finishDraft(draft: Draft, intent: Intent, msg: Message, reply: Reply) {
    this.store.setSetting('selected_draft', String(draft.id))
    const authorized = intent.sendNow && await authorizes(this.app.model, msg.text, 'send_now').catch(() => false)
    if (authorized && this.store.approveDirect(draft, Date.now()))
      return reply(`${label(draft)} 已确认并排队。`)
    return this.preview(draft, msg, reply)
  }

  private async preview(draft: Draft, msg: Message, reply: Reply) {
    const p = draft.payload
    const mail = this.store.mail(draft.mail)
    const from = mail?.from.join(', ') || '无'
    const text = [
      `${label(draft)} · 回复预览 M${draft.mail}${mail?.subject ? '「' + mail.subject + '」' : ''}`,
      '发信账号 ' + p.from, 'To ' + p.to.join(', '), 'Cc ' + (p.cc.join(', ') || '无'), 'Bcc 无',
      '原发件人 ' + from + (mail?.replyTo.length ? ' · Reply-To ' + mail.replyTo.join(', ') : ''),
      '主题 ' + p.subject, '附件 无', '快照 SHA-256 ' + draft.hash,
      ...(p.inReplyTo ? [] : ['原信缺少可用的 Message-ID，邮件客户端可能无法串联。']),
      '', p.text, '', '你可以直接说要发送、改哪里，或者先不发。'
    ].join('\n')
    await reply(text)
    this.store.showConfirmation(draft, msg, Date.now())
    this.store.setSetting('selected_draft', String(draft.id))
  }
}
