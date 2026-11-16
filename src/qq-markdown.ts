import type { ApiError, MessageResponse, QQBot, ReplyTarget } from '@tencent-connect/qqbot-nodejs'

const markdownRejectionCodes = new Set([40034012, 40034090, 50056])
const markdownPermissionError = /(?:不允许发送|无权限发送|未开通|不支持)\s*(?:原生\s*)?markdown|markdown\s*(?:未开通|无权限)|markdown\s+(?:is\s+)?not (?:allowed|permitted|supported)|permission denied for markdown/i
const markdownPayloadError = /markdown\s*(?:渲染失败|格式错误|内容超长|内容过长)|markdown\s+(?:rendering failed|content (?:is invalid|is too long|exceeds (?:the )?max(?:imum)? length))|invalid markdown (?:content|format|payload)/i
const lengthError = /(?:消息|内容|文本)(?:的|字节数|字符数|长度|大小|\s)*(?:过长|超长|超出|超限|超过)|(?:content|message|text)(?:\s+length)?(?:\s+\d+)?\s+(?:is too long|exceeds? (?:the )?(?:max(?:imum)? )?length)/i

function escapeLine(line: string) {
  return line.replace(/[\\`*_!\[\]<>~|&]/g, '\\$&')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^[#+=\-]/, '\\$&')
    .replace(/^[ \t]+/, indentation => indentation.replace(/ /g, '\u00a0').replace(/\t/g, '\u00a0'.repeat(4)))
    // A soft separator keeps the address legible while breaking automatic URL detection.
    .replace(/\b(?:[a-z][a-z0-9+.-]*(?=:\/\/)|www(?=\.))/gi, '$&\u200b')
}

function formatMarkdown(text: string) {
  const lines = text.split(/\r\n?|\n/).map(line => line.trimEnd())
  const isBullet = (line: string | undefined) => Boolean(line?.startsWith('• '))
  return lines.map((line, index) => {
    if (!line) return ''
    const bullet = isBullet(line)
    const escaped = escapeLine(bullet ? line.slice(2) : line)
    const formatted = bullet ? '- ' + escaped : index === 0 && line.length <= 120 ? `**${escaped}**` : escaped
    const next = lines[index + 1]
    if (!next) return formatted
    if (bullet !== isBullet(next)) return formatted + '\n'
    return bullet ? formatted : formatted + '  '
  }).join('\n')
}

function isMarkdownRejection(error: unknown) {
  if (isQqLengthRejection(error)) return true
  if (typeof error !== 'object' || error === null) return false
  const { httpStatus, bizCode, bizMessage } = error as Partial<ApiError>
  if (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus >= 500 ||
      httpStatus === 408 || httpStatus === 429) return false
  if (bizCode !== undefined && markdownRejectionCodes.has(bizCode)) return true
  return typeof bizMessage === 'string' && (markdownPermissionError.test(bizMessage) || markdownPayloadError.test(bizMessage))
}

function isQqLengthRejection(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const { httpStatus, bizCode, bizMessage } = error as Partial<ApiError>
  return httpStatus === 413 || (httpStatus === 400 &&
    (bizCode === 40054007 || (typeof bizMessage === 'string' && lengthError.test(bizMessage))))
}

type SendResult = { message: MessageResponse; format: 'markdown' | 'text'; markdownRejected?: true }

export async function sendQqText(bot: Pick<QQBot, 'sendMarkdown' | 'sendText'>, target: ReplyTarget, text: string,
  markdown = true, nativeMarkdown = false): Promise<SendResult> {
  if (markdown) {
    try {
      const content = nativeMarkdown ? text : formatMarkdown(text)
      return { message: await bot.sendMarkdown(target, content), format: 'markdown' }
    } catch (error) {
      if (!isMarkdownRejection(error)) throw error
      return { message: await bot.sendText(target, text), format: 'text', markdownRejected: true }
    }
  }
  return { message: await bot.sendText(target, text), format: 'text' }
}

export async function sendQqMessage(bot: Pick<QQBot, 'sendMarkdown' | 'sendText' | 'sendFile'>, target: ReplyTarget,
  text: string, markdown = true, nativeMarkdown = false
): Promise<SendResult | { message: MessageResponse | undefined; format: 'file'; markdownRejected?: never }> {
  try {
    return await sendQqText(bot, target, text, markdown, nativeMarkdown)
  } catch (error) {
    if (!isQqLengthRejection(error)) throw error
    const category = /^(?:#{1,6}[ \t]+)?(【(?:需要操作 · (?:紧急|不紧急)|无需操作)】)[ \t]*(?:\r?\n|$)/.exec(text)?.[1]
    const ref = /^(?:#{1,6}[ \t]+)?(M\d+|D\d+ v\d+)\b/m.exec(text)?.[1]
    const caption = [category, ref, '完整内容见附件。'].filter(Boolean).join('\n')
    const file = await bot.sendFile(target, { buffer: Buffer.from(text, 'utf8') },
      { fileName: (ref?.replace(' ', '-') ?? 'QQ-reply') + '.txt', content: caption })
    return { message: file.message, format: 'file' }
  }
}
