import { NativeFileError } from './deepseek-files.js'
import { freezeMime, MailIssue, retrySchedule } from './mail.js'
import { translateOriginal, writeOverview } from './model.js'
import type { Store } from './store.js'
import type { Attachment, Body, Mail, Mailbox, Notice, TextModel, Translation } from './types.js'

const chars = (s: string, max: number) => [...s].slice(0, max).join('')
const stamp = (value: number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
export function safeError(error: unknown) {
  if (error instanceof MailIssue) return error.code
  if (error instanceof NativeFileError) return 'model_file_' + error.code.replace(/[^a-z_]/g, '')
  const message = error instanceof Error ? error.message : ''
  return /^(?:model_[a-z_]+|SQLITE_[A-Z_]+)$/.test(message) ? message : 'operation_failed'
}
export function qqError(error: unknown) {
  const { httpStatus, bizCode } = (error ?? {}) as { httpStatus?: number; bizCode?: number }
  return {
    state: httpStatus === 429 ? 'limited' : httpStatus && httpStatus >= 400 && httpStatus < 500 ? 'failed' : 'unknown',
    issue: [httpStatus ? 'QQ HTTP ' + Number(httpStatus) : 'QQ 请求结果不明', bizCode ? '代码 ' + Number(bizCode) : ''].filter(Boolean).join(' ')
  }
}
const shanghaiMidnight = (now: number) => {
  const offset = 8 * 3600_000
  return Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset
}

export function attachmentLines(attachments: Attachment[], translation?: Translation | null, detail = false) {
  const summaries = new Map(translation?.attachmentSummaries?.map(item => [item.index, item]))
  return attachments.map((file, index) => {
    const summary = summaries.get(index)
    const points = summary?.points.join('；')
    const marker = detail ? `（${file.type}，${file.size} B）` : ''
    const reason = summary?.reason ?? file.extraction?.reason ?? (summary ? undefined : '附件内容尚未分析')
    const suffix = reason ? ' · ' + reason : ''
    return `附件 ${file.name}${marker}${points ? ' · ' + points : ''}${suffix}`
  })
}
export const attachmentSource = (name?: string) => name ? '（附件 ' + name + '）' : ''

export class Assistant {
  scanIssue: string | null = null
  qqConnected = false
  private translating = new Map<number, Promise<string>>()

  constructor(public readonly store: Store, private mailbox: Mailbox,
    public readonly model: TextModel, private appendSent = false) {}

  async scan() {
    try { await this.mailbox.scan(this.store); this.scanIssue = null }
    catch (error) { this.scanIssue = safeError(error) }
  }

  read(mail: Mail, originalAttachments = false) {
    if (mail.body && (!originalAttachments || !mail.body.attachments.length)) return Promise.resolve(mail.body)
    return this.mailbox.read(mail)
  }

  private async overviewSource(mail: Mail) {
    return this.read(mail, true).catch(error => {
      if (mail.body && error instanceof MailIssue && ['unavailable','uidvalidity_changed'].includes(error.code))
        return mail.body
      throw error
    })
  }

  async reviseOverview(mail: Mail, request: string) {
    if (mail.status !== 'ready') throw new MailIssue('请等邮件概要生成后再修改。')
    const body = await this.overviewSource(mail)
    const result = await writeOverview(this.store, mail, body, this.model, stamp(mail.received) + ' (Asia/Shanghai)', request)
    this.store.saveOverview(mail.id, result)
    return result
  }

  async originalTranslation(mail: Mail, body?: Body) {
    const cached = this.store.mail(mail.id)?.originalTranslation
    if (cached != null) return cached
    const existing = this.translating.get(mail.id)
    if (existing) return existing
    const result = (async () => {
      const source = body ?? await this.read(mail)
      const translated = await translateOriginal(this.store, mail, source.text, this.model)
      this.store.saveOriginalTranslation(mail.id, translated)
      return this.store.mail(mail.id)?.originalTranslation ?? translated
    })()
    this.translating.set(mail.id, result)
    try { return await result }
    finally { this.translating.delete(mail.id) }
  }

  async reviseOriginalTranslation(mail: Mail, request: string) {
    const body = await this.read(mail)
    const revised = await translateOriginal(this.store, mail, body.text, this.model, request)
    this.store.saveOriginalTranslation(mail.id, revised, true)
    return revised
  }

  async analyzeOnce() {
    const mail = this.store.nextMail()
    if (!mail) return false
    let body: Body
    try {
      body = await this.overviewSource(mail)
      if (body !== mail.body) this.store.saveBody(mail.id, body)
      const overview = await writeOverview(this.store, mail, body, this.model, stamp(mail.received) + ' (Asia/Shanghai)')
      this.store.completeMail(mail.id, overview)
    } catch (error) {
      const issue = safeError(error)
      const terminal = ['unavailable','mime_too_large','body_too_large','uidvalidity_changed','model_input_too_many_parts'].includes(issue)
      this.store.deferMail(mail, issue, terminal)
      this.store.queueNotice('mail/pending/' + mail.id, mail.id,
        `邮件助手处理提醒\nM${mail.id} · ${chars(mail.subject, 160)}\n${terminal ? '全文当前不可处理' : '新邮件待处理'}（${issue}），发送「详情 M${mail.id}」查看。`)
      return true
    }
    try { await this.originalTranslation(mail, body) }
    catch (error) { this.store.audit('translate_original', 'M' + mail.id, safeError(error)) }
    return true
  }

  async sendOnce() {
    const draft = this.store.nextSend()
    if (!draft) return false
    let mime
    try { mime = await freezeMime(draft.payload) }
    catch {
      this.store.completeSend(draft, { status: 'FAILED_BEFORE_SUBMIT', accepted: [], rejected: [], code: 'MIME 生成失败' })
      return true
    }
    if (!this.store.claimSend(draft, mime.raw, mime.messageId)) return false
    let result
    try { result = await this.mailbox.send(draft.payload, mime.raw) }
    catch { result = { status: 'UNKNOWN' as const, accepted: [], rejected: [] } }
    this.store.completeSend(draft, result, this.appendSent && result.status === 'ACCEPTED' ? 'pending' : undefined)
    return true
  }

  async saveCopyOnce() {
    const item = this.store.nextCopy()
    if (!item) return false
    this.store.copyState(item, 'saving')
    try { await this.mailbox.saveCopy(item.raw, item.message_id); this.store.copyState(item, 'saved') }
    catch {
      // The APPEND may already have arrived. Allow an explicit, deduplicated reconciliation.
      this.store.copyState(item, 'unknown')
      this.store.queueNotice(`sent-copy/${item.draft}/${item.version}`, null,
        `D${item.draft} v${item.version} 的已发送副本保存结果不明。SMTP 接受状态可在草稿中查看。`)
    }
    return true
  }

  async notifyOnce(send: (notice: Notice) => Promise<string | { id: string; ref?: string } | undefined>) {
    if (this.store.getSetting('notifications_paused') === '1') return false
    const now = Date.now()
    const budget = this.store.noticeBudget(now, shanghaiMidnight(now))
    if (budget.day >= 800 || budget.minute >= 10) return false
    const notice = this.store.nextNotice()
    if (!notice || !this.store.claimNotice(notice, now)) return false
    try {
      const receipt = await send(notice)
      const id = typeof receipt === 'string' ? receipt : receipt?.id
      this.store.finishNotice(notice, id ? 'accepted' : 'unknown', id ? undefined : 'QQ 未返回消息 ID', id, 0,
        typeof receipt === 'object' ? receipt.ref : undefined)
    } catch (error) {
      const { state, issue } = qqError(error)
      const delay = retrySchedule[notice.attempts]
      this.store.finishNotice(notice, state === 'limited' ? delay ? 'queued' : 'failed' : state, issue, undefined, (delay ?? 0) * 1000)
    }
    return true
  }
}
