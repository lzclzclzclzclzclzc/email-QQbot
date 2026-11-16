import { createServer } from 'node:http'
import { constantTimeEqual, nowShanghaiDay } from './runtime-utils.js'
import { mkdirSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { QQBot, QQBotInboundMessage, ReplyTarget } from '@tencent-connect/qqbot-nodejs'
import { Assistant, safeError } from './assistant.js'
import { readConfig } from './config.js'
import { Conversation } from './conversation.js'
import { analyzeDeepSeekFile, analyzeDeepSeekFiles, NativeFileError, type NativeAttachment } from './deepseek-files.js'
import { ImapSmtpMailbox, retrySchedule } from './mail.js'
import { sendQqMessage } from './qq-markdown.js'
import { Store } from './store.js'
import type { TextModel } from './types.js'

export const name = 'mail-assistant'
export const inject = ['llm', 'agentDefaultModel']

type Config = ReturnType<typeof readConfig>
type ModelChoice = { provider: string; model: string }
type RuntimeContext = Context & { llm: LlmRuntime; agentDefaultModel: { currentSelection(): ModelChoice } }

export function dshModel(ctx: RuntimeContext, store: Store, config: Config, shutdown: AbortSignal): TextModel {
  return async (system, text, file) => {
    const date = nowShanghaiDay(Date.now())
    const counter = 'model_calls/' + date
    const count = Number(store.getSetting(counter) ?? 0)
    if (count >= config.modelCallsDaily) throw Error('model_daily_limit')
    const route = config.modelProvider ? { provider: config.modelProvider, model: config.modelName }
      : ctx.agentDefaultModel.currentSelection()
    if (!route.provider || !route.model) throw Error('model_route_missing')
    if (file) {
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
      const configuredBase = process.env.DEEPSEEK_BASE_URL?.trim()
      const officialBase = !configuredBase || /^https:\/\/api\.deepseek\.com(?:\/anthropic(?:\/v1)?)?\/?$/i.test(configuredBase)
      if (!apiKey || route.provider !== 'deepseek-official' || route.model !== 'deepseek-flash' || !officialBase)
        throw new NativeFileError('route_unsupported', '当前模型路由未配置可用的原生文件接口')
      store.setSetting(counter, String(count + 1))
      const request = { apiKey, model: route.model, system, input: text, signal: shutdown }
      return 'files' in file ? analyzeDeepSeekFiles({ ...request, ...file }) : analyzeDeepSeekFile({ ...request, file })
    }
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(90_000)])
    store.setSetting(counter, String(count + 1))
    const out = new Map<number, string>()
    let finish: string | undefined
    for await (const chunk of ctx.llm.stream({
      ...route, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      tools: [], signal
    })) {
      if (chunk.type === 'text-delta') out.set(chunk.index, (out.get(chunk.index) ?? '') + chunk.text)
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' && /context[_ ]length[_ ]exceeded|maximum context length|context (?:is )?too long/i
          .test(chunk.reason.failure?.code + ' ' + chunk.reason.failure?.message)) throw Error('model_context_length')
        finish = chunk.reason.kind
      }
    }
    const response = [...out].sort(([a], [b]) => a - b).map(([, s]) => s).join('')
    if (finish === 'max-tokens') throw Error('model_output_limit')
    if (finish === 'error') throw Error('model_error')
    if (finish !== 'stop' || !response.trim()) throw Error('model_incomplete')
    return response
  }
}

export function apply(ctx: RuntimeContext) {
  const config = readConfig()
  process.umask(0o077)
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
  const store = new Store(join(config.stateDir, 'mail.sqlite'))
  const mailbox = new ImapSmtpMailbox(config)
  const shutdown = new AbortController()
  let connectedBot: QQBot | undefined
  let started = true
  let input = Promise.resolve()
  let queued = 0
  let enrolled = false
  const assistant = new Assistant(store, mailbox, dshModel(ctx, store, config, shutdown.signal), Boolean(config.sentFolder))
  const conversation = new Conversation(assistant, config.owner, config.user)
  const log = (job: string, issue: string) => console.warn('[dsh-mail] ' + job + ' ' + issue)
  const formats = { reply: 'unknown', notice: 'unknown' }
  const retryMarkdownAt = { reply: 0, notice: 0 }
  const send = async (kind: keyof typeof formats, bot: QQBot, target: ReplyTarget, text: string, nativeMarkdown = false) => {
    const markdown = config.live && Date.now() >= retryMarkdownAt[kind]
    const delivered = await sendQqMessage(bot, target, text, markdown, nativeMarkdown)
    if (!delivered.message?.id) throw Error('qq_reply_unconfirmed')
    formats[kind] = delivered.format
    if (delivered.markdownRejected) retryMarkdownAt[kind] = Date.now() + 15 * 60_000
    return delivered.message
  }
  const health = () => {
    const h = store.health()
    const disk = statfsSync(config.stateDir)
    const freeBytes = disk.bavail * disk.bsize
    const stale = !h.lastScan || Date.now() - h.lastScan > 90_000
    const scanPaused = store.getSetting('scan_paused') === '1'
    const state = !config.live ? 'setup' : stale || scanPaused || h.reconcile || !assistant.qqConnected ||
      assistant.scanIssue || h.smtpUnknown || h.smtpPartial || h.qqFailed || h.qqUnknown ||
      h.failed || h.sentCopyIssues || freeBytes < 64 * 1024 * 1024 ? 'degraded' : 'running'
    return { ...h, state, freeBytes, scanPaused, scanIssue: assistant.scanIssue, qqConnected: assistant.qqConnected,
      notificationsPaused: store.getSetting('notifications_paused') === '1',
      qqReplyFormat: formats.reply, qqNoticeFormat: formats.notice }
  }

  try { if (config.live) store.bind(config.user, config.appId, config.owner) }
  catch (error) { store.close(); throw error }

  ctx.provide('mailAssistantBridge', {
    attach(gatewayContext: Context, bot: QQBot, appId: string) {
      if (!config.appId || appId !== config.appId || (!config.enroll && !config.live)) return
      if (connectedBot) throw Error('已有 QQ 网关')
      connectedBot = bot
      const online = () => { assistant.qqConnected = true }
      bot.on('ready', online)
      bot.on('resumed', online)
      bot.on('disconnected', () => { assistant.qqConnected = false })
      bot.on('error', () => { log('qq', 'gateway_error') })
      bot.on('message', (_event, msg: QQBotInboundMessage) => {
        if (msg.kind !== 'c2c' || msg.senderIsBot || msg.replyTarget.scope !== 'c2c' ||
            msg.senderId !== msg.replyTarget.targetId || !msg.messageId || !started) return
        if (config.live && msg.senderId !== config.owner) return
        if (queued >= 20) return
        const receivedAt = Date.now()
        const timestamp = Date.parse(msg.timestamp)
        const qqSentAt = Number.isFinite(timestamp) ? timestamp : undefined
        queued++
        input = input.then(async () => {
          if (!started) return
          const reply = async (text: string, file?: NativeAttachment, nativeMarkdown = false) => {
            if (file) {
              const fileName = file.name.replace(/[\\/\u0000-\u001f\u007f]/g, '_')
              const delivered = await bot.sendFile(msg.replyTarget, { buffer: file.data }, { fileName, content: text })
              if (!delivered.message?.id) throw Error('qq_file_unconfirmed')
            } else {
              await send('reply', bot, msg.replyTarget, text, nativeMarkdown)
            }
          }
          if (!config.live) {
            if (!config.enroll || enrolled || !constantTimeEqual(msg.content.trim(), '绑定 ' + config.enroll)) return
            writeFileSync(join(config.stateDir, 'qq-owner.openid'), msg.senderId + '\n', { flag: 'wx', mode: 0o600 })
            enrolled = true
            await reply('已记录你的 QQ OpenID。请在本机完成配置并重启。')
            return
          }
          await conversation.handle({
            owner: msg.senderId, chat: msg.replyTarget.targetId, scope: msg.kind, event: msg.messageId, receivedAt, qqSentAt,
            text: msg.content, quote: msg.refMsgIdx, quotedText: msg.refMsgIdx ? msg.msgElements?.[0]?.content : undefined
          }, reply)
        }).catch(() => log('qq', 'response_failed')).finally(() => { queued-- })
      })

      gatewayContext.effect(() => {
        void bot.start().catch(() => { assistant.qqConnected = false; log('qq', 'gateway_start_failed') })
        return () => {
          bot.stop()
          if (connectedBot === bot) connectedBot = undefined
          assistant.qqConnected = false
        }
      }, 'dsh-mail.qq')
    }
  })

  ctx.effect(() => {
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/health') {
        response.writeHead(404).end()
        return
      }
      try {
        const body = health()
        response.writeHead(body.state === 'degraded' ? 503 : 200,
          { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(body))
      } catch { response.writeHead(503).end('health unavailable') }
    })
    server.on('error', () => log('health', 'listen_failed'))
    server.listen(config.healthPort, '127.0.0.1')
    const active = new Set<Promise<unknown>>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    function cycle(job: string, task: () => Promise<number>) {
      const run = () => {
        if (!started) return
        const work = Promise.resolve().then(task)
        active.add(work)
        void work.catch(error => { log(job, safeError(error)); return 30_000 }).then(delay => {
          active.delete(work)
          if (!started) return
          const timer = setTimeout(() => { timers.delete(timer); run() }, delay)
          timers.add(timer)
        })
      }
      run()
    }
    if (config.live) {
      let tries = 0
      cycle('scan', async () => {
        if (store.getSetting('scan_paused') === '1') return 30_000
        await assistant.scan()
        if (!assistant.scanIssue) { tries = 0; return 30_000 }
        log('imap', assistant.scanIssue)
        if (assistant.scanIssue === 'imap_auth_failed') return 30 * 60_000
        return Math.max(30, retrySchedule[Math.min(tries++, retrySchedule.length - 1)]) * 1000
      })
      cycle('analysis', async () => {
        const disk = statfsSync(config.stateDir)
        if (disk.bavail * disk.bsize < 64 * 1024 * 1024) return 60_000
        return (await assistant.analyzeOnce()) ? 100 : 2500
      })
      cycle('smtp', async () => {
        await assistant.sendOnce()
        await assistant.saveCopyOnce()
        return 2000
      })
      cycle('outbox', async () => {
        const bot = connectedBot
        if (bot && assistant.qqConnected) await assistant.notifyOnce(async notice => {
          const target = { scope: 'c2c' as const, targetId: config.owner }
          if (notice.file_name) {
            const result = await bot.sendFile(target, { buffer: Buffer.from(notice.text, 'utf8') }, { fileName: notice.file_name })
            return result.message?.id ? { id: result.message.id, ref: result.message.ext_info?.ref_idx } : undefined
          }
          const result = await send('notice', bot, target, notice.text, Boolean(notice.is_markdown))
          return result?.id ? { id: result.id, ref: result.ext_info?.ref_idx } : undefined
        })
        return 6000
      })
      cycle('retention', async () => { store.purge(); return 6 * 3600_000 })
    }
    return async () => {
      started = false
      shutdown.abort()
      for (const timer of timers) clearTimeout(timer)
      server.close()
      mailbox.close()
      await Promise.allSettled([...active, input])
      store.close()
    }
  }, 'dsh-mail.lifecycle')
  console.info('[dsh-mail] ' + (config.live ? 'live' : config.enroll ? 'owner enrollment' : 'setup') +
    ' · local health on 127.0.0.1:' + config.healthPort)
}
