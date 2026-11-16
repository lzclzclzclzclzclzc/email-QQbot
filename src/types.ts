import type { AttachmentExtraction } from './attachment-text.js'
import type { NativeAttachment } from './deepseek-files.js'

export interface Envelope {
  uid: number
  received: number
  subject: string
  from: string[]
  replyTo: string[]
  to: string[]
  cc: string[]
  messageId?: string
  size: number
}
export interface Attachment {
  name: string
  size: number
  type: string
  extraction?: AttachmentExtraction
  data?: Buffer
}

export interface Body {
  text: string
  references: string[]
  attachments: Attachment[]
}
export type MailClassification = 'urgent_action' | 'action' | 'no_action'
export interface Summary {
  classification?: MailClassification
  language: string
  subject: string
  points: string[]
  actions: { text: string; basis: 'explicit' | 'suggestion'; attachment?: string }[]
  deadlines: { raw: string; normalized: string | null; attachment?: string }[]
  shouldReply: boolean
}
export interface Translation extends Summary {
  text: string
  parts: number
  attachmentSummaries?: { index: number; points: string[]; reason?: string }[]
}
export interface Mail extends Envelope {
  id: number
  validity: string
  status: string
  issue: string | null
  attempts: number
  body: Body | null
  translation: Translation | null
  summaryMarkdown: string | null
  originalTranslation: string | null
}
export interface Payload {
  from: string
  to: string[]
  cc: string[]
  subject: string
  text: string
  inReplyTo?: string
  references: string[]
}
export interface Draft {
  id: number
  version: number
  mail: number
  hash: string
  state: string
  payload: Payload
}
export interface Identity { owner: string; chat: string; event: string; receivedAt?: number; qqSentAt?: number }
export interface Notice {
  key: string
  mail: number | null
  text: string
  file_name: string | null
  is_markdown: number
  attempts: number
  state: string
}
export type NativeMailFiles = { files: readonly NativeAttachment[]; allowPartial: boolean }
export type TextModel = (system: string, input: string, files?: NativeAttachment | NativeMailFiles) => Promise<string>
export type SendState = 'ACCEPTED' | 'PARTIAL' | 'UNKNOWN' | 'FAILED_BEFORE_SUBMIT'
export interface SendResult {
  status: SendState
  accepted: string[]
  rejected: string[]
  code?: string
}
export interface Mailbox {
  scan: (store: import('./store.js').Store) => Promise<void>
  read: (mail: Mail) => Promise<Body>
  send: (payload: Payload, raw: string) => Promise<SendResult>
  saveCopy: (raw: string, messageId: string) => Promise<void>
}
