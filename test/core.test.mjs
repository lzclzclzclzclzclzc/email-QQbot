import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../lib/store.js'
import { findMail, parseMail, replyEnvelope } from '../lib/mail.js'
import { splitText, translate } from '../lib/model.js'
import { Assistant } from '../lib/assistant.js'
import { Conversation } from '../lib/conversation.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-test-'))
  const path = join(dir, 'mail.sqlite')
  const store = new Store(path)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { path, store }
}
const mail = (uid, overrides = {}) => ({
  uid, received: 123, subject: 'Hello', from: ['from@example.net'],
  replyTo: ['replies@example.net'], to: ['me@163.com'], cc: ['cc@example.net'],
  messageId: '<original@example.net>', size: 256, ...overrides
})
const summaryModel = async (_system, _input) => JSON.stringify({
  language: 'zh', subject: '测试', points: ['收到来信'], actions: [], deadlines: [], shouldReply: false
})
const overviewMarkdown = (label, points, attachments = []) => [
  label, '# 测试主题', '## 1. 概要', ...points.map(point => '- ' + point), '## 2. 待办', '见概要。',
  '## 3. 附件', ...(attachments.length ? attachments.map(point => '- ' + point) : ['无附件']), '## 4. 助手建议', '无。'
].join('\n')
const payload = {
  from: 'me@163.com', to: ['replies@example.net'], cc: [], subject: 'Re: Hello',
  text: 'Exact body', inReplyTo: '<original@example.net>', references: ['<original@example.net>']
}
const identity = { owner: 'openid-1', chat: 'openid-1', event: 'event-1' }

test('first scan ignores old mail and a bounded UID walk discovers all 250 new messages', async t => {
  const { store } = fixture(t)
  await findMail(store, { validity: '1', next: 601, fetch: async () => { throw Error('baseline must not fetch') } })
  const ranges = []
  const fetch = async (start, end) => {
    ranges.push([start, end])
    return [mail(1), ...Array.from({ length: end - start + 1 }, (_, i) => mail(start + i))]
  }
  await findMail(store, { validity: '1', next: 851, fetch })
  assert.deepEqual(ranges, [[601, 800], [801, 850]])
  assert.equal(store.recent(300).length, 250)
  assert.equal(store.cursor().last_uid, 850)
})

test('partial IMAP fetch can be repeated without advancing or duplicating a committed page', async t => {
  const { store } = fixture(t)
  await findMail(store, { validity: '1', next: 2, fetch: async () => [] })
  await assert.rejects(findMail(store, { validity: '1', next: 203, fetch: async start => {
    if (start > 2) throw Error('disconnect')
    return [mail(3)]
  }}), /disconnect/)
  assert.equal(store.cursor().last_uid, 201)
  await findMail(store, { validity: '1', next: 203, fetch: async () => [mail(3), mail(202)] })
  assert.deepEqual(store.recent().map(m => m.uid), [202, 3])
})

test('UIDVALIDITY change freezes the old cursor pending explicit reconciliation', async t => {
  const { store } = fixture(t)
  await findMail(store, { validity: '1', next: 10, fetch: async () => [] })
  await findMail(store, { validity: '2', next: 15, fetch: async () => { throw Error('unexpected fetch') } })
  assert.equal(store.cursor().validity, '1')
  assert.equal(store.cursor().reconcile, '2')
  await findMail(store, { validity: '1', next: 11, fetch: async () => [mail(10)] })
  assert.equal(store.cursor().reconcile, null)
  assert.equal(store.recent()[0].uid, 10)
})

test('HTML MIME parsing preserves useful text and omits hidden or active content', async () => {
  const raw = 'MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
    '<p>交付<strong>安排</strong></p><script>TRACK</script><img alt="PIXEL" src="https://example.net/p.gif">' +
    '<div style="display: none">HIDDEN</div><a href="https://example.net">链接</a>'
  const body = await parseMail(Buffer.from(raw))
  assert.match(body.text, /交付安排/)
  assert.match(body.text, /链接/)
  assert.doesNotMatch(body.text, /TRACK|PIXEL|HIDDEN/)
})

test('reply-to and reply-all exclude self and remove duplicate recipients', () => {
  const body = { references: ['<older@example.net>'] }
  const original = mail(1, { to: ['cc@example.net', 'ME@163.com'] })
  assert.deepEqual(replyEnvelope(original, body, 'me@163.com', 'hi', false).cc, [])
  const reply = replyEnvelope(original, body, 'me@163.com', 'hi', true)
  assert.deepEqual(reply.to, ['replies@example.net'])
  assert.deepEqual(reply.cc, ['cc@example.net'])
  assert.deepEqual(reply.references, ['<older@example.net>', '<original@example.net>'])
})

test('translation splitting preserves exact characters including non-BMP text', () => {
  const source = 'abc😀\n\nDEF😀😀 😀'
  const chunks = splitText(source, 6)
  assert.equal(chunks.join(''), source)
  assert(chunks.every(chunk => [...chunk].length <= 6))
})

test('Chinese body stays verbatim and the foreign text resumes at the failed translation part', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 2, [mail(1), mail(2)])
  const cn = await translate(store, 1, 'Hello', '一封中文邮件\n\n第二段。', summaryModel)
  assert.equal(cn.text, '一封中文邮件\n\n第二段。')
  let tries = 0
  const model = async (system, input) => {
    if (system.includes('完整翻译')) {
      tries++
      if (tries === 2) throw Error('temporary')
      return '译文' + JSON.parse(input).part
    }
    return JSON.stringify({ language: 'en', subject: '主题', points: ['摘要'], actions: [], deadlines: [], shouldReply: false })
  }
  const text = 'a'.repeat(3150)
  await assert.rejects(translate(store, 2, 'Long', text, model), /temporary/)
  const resumed = await translate(store, 2, 'Long', text, model)
  assert.equal(tries, 3)
  assert.equal(resumed.text, '译文1\n\n译文2')
})

test('approval requires delivered preview, original owner and chat, current version and a new event', t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const d1 = store.createDraft(1, payload)
  assert.equal(store.approve(d1, identity, 1001), false)
  const d2 = store.reviseDraft(d1, { ...payload, text: 'Version two' })
  assert.equal(store.showConfirmation(d1, identity, 1000), false)
  assert.equal(store.showConfirmation(d2, identity, 1000), true)
  assert.equal(store.approve(d2, identity, 1001), false)
  assert.equal(store.approve(d2, { ...identity, chat: 'forwarded', event: 'e2' }, 1001), false)
  assert.equal(store.approve(d2, { ...identity, owner: 'other', event: 'e3' }, 1001), false)
  assert.equal(store.approve(d2, { ...identity, event: 'e5' }, 602001), true)
  assert.equal(store.approve(d2, { ...identity, event: 'e6' }, 602002), false)
  assert.equal(store.nextSend().payload.text, 'Version two')
})

test('recovery does not repeat SMTP or QQ writes in progress at crash', t => {
  const { store, path } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const draft = store.createDraft(1, payload)
  store.showConfirmation(draft, identity, 100)
  store.approve(draft, { ...identity, event: 'e2' }, 101)
  store.claimSend(draft, 'frozen mime', '<stable@163.com>')
  store.queueNotice('mail/1', 1, 'ready')
  store.claimNotice(store.nextNotice(), Date.now())
  assert.throws(() => new Store(path), /实例/)
  store.close()
  const recovered = new Store(path)
  try {
    assert.equal(recovered.nextSend(), undefined)
    assert.equal(recovered.nextNotice()?.key, 'send/1/1')
    assert.equal(recovered.health().smtpUnknown, 1)
    assert.equal(recovered.health().qqUnknown, 1)
  } finally { recovered.close() }
})

test('a failed QQ send does not repeat a partial SMTP delivery', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const draft = store.createDraft(1, payload)
  store.showConfirmation(draft, identity, 100)
  store.approve(draft, { ...identity, event: 'e2' }, 101)
  let sent = 0
  const assistant = new Assistant(store, {
    send: async () => {
      sent++
      return { status: 'PARTIAL', accepted: ['replies@example.net'], rejected: ['cc@example.net'] }
    }
  }, summaryModel)
  await assistant.sendOnce()
  await assistant.notifyOnce(async () => { throw Error('network timeout') })
  await assistant.sendOnce()
  assert.equal(sent, 1)
  assert.equal(store.latestDraft(1).state, 'PARTIAL')
  assert.equal(store.health().qqUnknown, 1)
})

test('QQ owner identity is checked before commands and the same event cannot complete a preview', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const d = store.createDraft(1, payload)
  const chat = new Conversation(new Assistant(store, {}, summaryModel), 'openid-1', 'me@163.com')
  const replies = []
  const message = { ...identity, scope: 'c2c', text: '发送 D1 v1' }
  const reply = async text => { replies.push(text) }
  await chat.handle({ ...message, owner: 'impersonator' }, reply)
  assert.deepEqual(replies, [])
  await chat.handle(message, reply)
  await chat.handle(message, reply)
  assert.match(replies[0], /Exact body/)
  assert.equal(store.latestDraft(d.id).state, 'AWAITING_CONFIRMATION')
  await new Promise(resolve => setTimeout(resolve, 5))
  await chat.handle({ ...message, event: 'new-event', receivedAt: Date.now() }, reply)
  assert.equal(store.latestDraft(d.id).state, 'QUEUED')
})

test('generic SMTP connection loss cannot identify whether DATA was accepted', async () => {
  const { smtpFailure } = await import('../lib/mail.js')
  assert.equal(smtpFailure({ code: 'ETIMEDOUT', command: 'CONN' }).status, 'UNKNOWN')
  assert.equal(smtpFailure({ code: 'ESOCKET', command: 'CONN' }).status, 'UNKNOWN')
  assert.equal(smtpFailure({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }).status, 'FAILED_BEFORE_SUBMIT')
})

test('a second event received during preview cannot authorize SMTP', t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const draft = store.createDraft(1, payload)
  store.showConfirmation(draft, identity, 5000)
  assert.equal(store.approve(draft, { ...identity, event: 'early', receivedAt: 4900 }, 5100), false)
  assert.equal(store.approve(draft, { ...identity, event: 'delayed', receivedAt: 5100, qqSentAt: 4000 }, 5200), false)
  assert.equal(store.approve(draft, { ...identity, event: 'late', receivedAt: 5300, qqSentAt: 5200 }, 5400), true)
})

test('UID reconciliation preserves the original mail ID and maps identical arrivals one to one', t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  store.deferMail(store.mail(1), 'uidvalidity_changed', true)
  store.reconcile('2')
  store.resetAfterReview('2', 10, 100, [mail(8), mail(9), mail(10)])
  assert.equal(store.mail(1).uid, 8)
  assert.equal(store.mail(1).validity, '2')
  assert.equal(store.mail(1).status, 'waiting')
  assert.deepEqual(store.recent().map(item => item.uid), [10, 9, 8])
})

test('ambiguous SMTP address syntax is excluded before approval', () => {
  const bad = 'a."replaced"@example.net'
  const original = mail(1, { replyTo: [bad] })
  const reply = replyEnvelope(original, { references: [] }, 'me@163.com', 'hi', false)
  assert.deepEqual(reply.to, ['from@example.net'])
})

test('fetch combines solicited metadata across UID rows and ignores flags-only updates', async () => {
  const { fetchEnvelopes } = await import('../lib/mail.js')
  const messages = {
    async *fetch() {
      yield { uid: 40, flags: new Set(['seen']) }
      yield { uid: 41, flags: new Set(['seen']) }
      yield { uid: 41, size: 29 }
      yield { uid: 41, envelope: { subject: 'Mail', from: [{ address: 'sender@example.com' }] } }
      yield { uid: 41, internalDate: new Date(3000) }
    }
  }
  const rows = await fetchEnvelopes(messages, '40:41', uid => uid >= 40 && uid <= 41)
  assert.deepEqual(rows.map(m => [m.uid, m.subject, m.received, m.size]), [[41, 'Mail', 3000, 29]])
})

test('missing UIDNEXT can use the last live UID while keeping a future-only baseline', async t => {
  const { inboxBoundary } = await import('../lib/mail.js')
  const { store } = fixture(t)
  const selections = []
  const imap = {
    mailbox: { uidValidity: 93n, exists: 30 },
    async fetchOne(range, query) {
      selections.push([range, query])
      return { uid: 140 }
    }
  }
  const boundary = await inboxBoundary(imap)
  await findMail(store, { ...boundary, fetch: async () => assert.fail('initial scan should only save a baseline') })
  assert.deepEqual(selections, [['*', { uid: true }]])
  assert.equal(store.cursor().last_uid, 140)
  assert.deepEqual(store.recent(), [])
})

test('deleting the last message cannot move an inferred UID cursor backward', async t => {
  const { store } = fixture(t)
  store.baseline('5', 142)
  await findMail(store, { validity: '5', next: 113, inferred: true, fetch: async () => assert.fail('old mail should not be fetched') })
  assert.equal(store.cursor().last_uid, 142)
  await findMail(store, { validity: '5', next: 151, inferred: true, fetch: async (start, end) => {
    assert.deepEqual([start, end], [143, 150])
    return [mail(150)]
  }})
  assert.equal(store.recent()[0].uid, 150)
})

test('the inferred boundary rejects an uncertain nonempty mailbox and handles an empty one', async () => {
  const { inboxBoundary } = await import('../lib/mail.js')
  const imap = { mailbox: { uidValidity: 10n, exists: 3 }, fetchOne: async () => false }
  await assert.rejects(inboxBoundary(imap), /uidnext_unavailable/)
  imap.mailbox.exists = 0
  assert.deepEqual(await inboxBoundary(imap), { validity: '10', next: 1, inferred: true })
})

test('natural QQ requests use mail context to find and draft a reply', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 2, [mail(1, { subject: 'Friday agenda' }), mail(2, { subject: 'Status update' })])
  store.saveBody(1, { text: 'Are you available Friday?', references: [], attachments: [] })
  const model = async (_system, input) => {
    const request = JSON.parse(input)
    if (request.mails) {
      assert.deepEqual(request.mails.map(item => item.id), ['M2', 'M1'])
      assert.equal(request.mails.some(item => 'body' in item), false)
      return JSON.stringify({ action: 'reply', target: 'M1' })
    }
    assert.equal(request.request, '帮我回一下提到周五议程的邮件，就说我能参加。')
    assert.equal(request.original, 'Are you available Friday?')
    return 'I can attend on Friday.'
  }
  const chat = new Conversation(new Assistant(store, {}, model), 'openid-1', 'me@163.com')
  const replies = []
  await chat.handle({ ...identity, scope: 'c2c', text: '帮我回一下提到周五议程的邮件，就说我能参加。' }, async text => { replies.push(text) })
  assert.equal(store.latestDraft(1)?.mail, 1)
  assert.equal(store.latestDraft(1)?.state, 'AWAITING_CONFIRMATION')
  assert.match(replies.join('\n'), /I can attend on Friday/)
  assert.equal(store.nextSend(), undefined)
})

test('natural requests to edit the current draft produce a new preview and invalidate the old one', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const prior = store.createDraft(1, payload)
  store.showConfirmation(prior, identity, 100)
  store.setSetting('selected_draft', '1')
  const model = async (_system, input) => {
    const request = JSON.parse(input)
    if (request.mails) {
      assert.equal(request.context.currentDraft, 'D1')
      return JSON.stringify({ action: 'revise', target: 'D1' })
    }
    assert.equal(request.draft, 'Exact body')
    return 'Thanks for checking. Friday works for me.'
  }
  const chat = new Conversation(new Assistant(store, {}, model), 'openid-1', 'me@163.com')
  await chat.handle({ ...identity, event: 'edit', scope: 'c2c', text: '刚才那个太生硬了，帮我写客气一点。' }, async () => {})
  assert.equal(store.latestDraft(1)?.version, 2)
  assert.match(store.latestDraft(1).payload.text, /Thanks for checking/)
  assert.equal(store.draft(1, 1)?.state, 'SUPERSEDED')
  assert.equal(store.nextSend(), undefined)
})

test('a new QQ overview becomes the default reply target after an older mail was selected', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 2, [mail(1, { subject: 'Earlier test' }), mail(2, { subject: 'New test' })])
  store.setSetting('selected_mail', '1')
  store.queueNotice('mail/2', 2, '新来信 Markdown')
  store.finishNotice(store.nextNotice(), 'accepted', undefined, 'qq-notice-new', 0, 'qq-ref-new')
  const assistant = new Assistant(store, {
    read: async current => ({ text: current.subject, references: [], attachments: [] })
  }, async (_system, input) => {
    const source = JSON.parse(input)
    return source.mails ? JSON.stringify({ action: 'reply', target: source.context.currentMail }) : 'Thanks.'
  })
  const chat = new Conversation(assistant, 'openid-1', 'me@163.com')
  const replies = []
  await chat.handle({ ...identity, scope: 'c2c', text: '帮我回一下这封，就说收到' }, async text => { replies.push(text) })
  assert.equal(store.latestDraft(1)?.mail, 2)
  assert.match(replies[0], /M2.*New test/)
})

test('an actual QQ quote wins over a conflicting model-selected reply target', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 2, [mail(1, { subject: 'Earlier test' }), mail(2, { subject: 'New test' })])
  store.setSetting('selected_mail', '1')
  store.queueNotice('mail/2', 2, '新来信 Markdown')
  store.finishNotice(store.nextNotice(), 'accepted', undefined, 'qq-notice-new', 0, 'qq-ref-new')
  const assistant = new Assistant(store, {
    read: async current => ({ text: current.subject, references: [], attachments: [] })
  }, async (_system, input) => JSON.parse(input).mails
    ? JSON.stringify({ action: 'reply', target: 'M1' }) : 'Thanks.')
  const chat = new Conversation(assistant, 'openid-1', 'me@163.com')
  await chat.handle({ ...identity, scope: 'c2c', quote: 'qq-ref-new', text: '帮我回这一封' }, async () => {})
  assert.equal(store.latestDraft(1)?.mail, 2)
})

test('a revision opens a new preview and SMTP sends only the separately confirmed version', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const prior = store.createDraft(1, payload)
  store.showConfirmation(prior, identity, Date.now() - 1000)
  store.setSetting('selected_draft', '1')
  const sent = []
  const assistant = new Assistant(store, {
    send: async incoming => {
      sent.push(incoming.text)
      return { status: 'ACCEPTED', accepted: incoming.to, rejected: [] }
    }
  }, async (system, input) => {
    if (system.includes('按语义判断')) return JSON.stringify({ action: 'send_now' })
    if (JSON.parse(input).mails) return JSON.stringify({ action: 'revise', target: 'D1', sendNow: true })
    return 'Updated reply.'
  })
  const chat = new Conversation(assistant, 'openid-1', 'me@163.com')
  const say = (event, text) => chat.handle({ ...identity, scope: 'c2c', event, text }, async () => {})
  await say('edit', '把结尾改成更自然的表达')
  assert.equal(store.draft(1, 1)?.state, 'SUPERSEDED')
  assert.equal(store.draft(1, 2)?.state, 'AWAITING_CONFIRMATION')
  await say('old-confirm', '发送D1 v1')
  assert.equal(await assistant.sendOnce(), false)
  assert.deepEqual(sent, [])
  await new Promise(resolve => setTimeout(resolve, 5))
  await say('new-confirm', '发送D1 v2')
  assert.equal(await assistant.sendOnce(), true)
  await say('repeat-confirm', '发送D1 v2')
  assert.equal(await assistant.sendOnce(), false)
  assert.deepEqual(sent, ['Updated reply.'])
})

test('a model-selected send or invented target never approves or accesses records', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 2, [mail(1), mail(2)])
  const draft = store.createDraft(1, payload)
  store.showConfirmation(draft, identity, Date.now() - 1000)
  store.setSetting('selected_draft', '1')
  let decision = { action: 'send', target: 'D1' }
  let reads = 0
  let interpreted = 0
  const assistant = new Assistant(store, { read: async () => { reads++; throw Error('unexpected read') } }, async () => { interpreted++; return JSON.stringify(decision) })
  const chat = new Conversation(assistant, 'openid-1', 'me@163.com')
  const replies = []
  const reply = async text => { replies.push(text) }
  await chat.handle({ ...identity, event: 'fuzzy-send', scope: 'c2c', text: '就这样发送吧' }, reply)
  assert.equal(store.nextSend(), undefined)
  decision = { action: 'original', target: 'M990' }
  await chat.handle({ ...identity, event: 'invented', scope: 'c2c', text: '那封的原信是什么' }, reply)
  assert.equal(reads, 0)
  assert.equal(interpreted, 2)
  assert.equal(replies.length, 2)
})

test('compact QQ confirmation accepts a separate event in the same platform timestamp second', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const draft = store.createDraft(1, payload)
  const second = Math.floor(Date.now() / 1000) * 1000 - 2000
  store.showConfirmation(draft, identity, second + 100)
  const replies = []
  const chat = new Conversation(new Assistant(store, {}, async () => assert.fail('model unnecessary')), 'openid-1', 'me@163.com')
  await chat.handle({ ...identity, scope: 'c2c', event: 'confirm-compact', text: '发送D1 v1”',
    receivedAt: second + 400, qqSentAt: second }, async text => { replies.push(text) })
  assert.equal(store.nextSend()?.state, 'QUEUED')
  assert.match(replies[0], /D1 v1 已确认/)
})

test('natural QQ confirmation uses the current already-previewed draft', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const draft = store.createDraft(1, payload)
  store.showConfirmation(draft, identity, Date.now() - 1000)
  store.setSetting('selected_draft', '1')
  const chat = new Conversation(new Assistant(store, {}, async () => JSON.stringify({ action: 'confirm' })), 'openid-1', 'me@163.com')
  await chat.handle({ ...identity, scope: 'c2c', event: 'confirm-naturally', text: '可以，就按刚才那个发出去吧。' }, async () => {})
  assert.equal(store.nextSend()?.id, draft.id)
})

test('natural requests can pause notifications and explicitly authorize a new exact reply', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const pause = '接下来想专心工作，QQ 的新邮件提醒先安静一下。'
  const request = '给 M1 的原发件人直接寄回这句话，原样即可：I can make it.'
  const model = async (_system, input) => {
    const source = JSON.parse(input)
    if (source.request === pause) return JSON.stringify({ action: 'pause_notifications' })
    if (!source.mails) {
      assert.equal(source.request, request)
      return JSON.stringify({ action: 'send_now' })
    }
    return JSON.stringify({ action: 'reply', target: 'M1', body: 'I can make it.', sendNow: true })
  }
  const chat = new Conversation(new Assistant(store,
    { read: async () => ({ text: '正文', references: [], attachments: [] }) }, model), 'openid-1', 'me@163.com')
  const replies = []
  const reply = async text => { replies.push(text) }
  await chat.handle({ ...identity, scope: 'c2c', text: pause }, reply)
  assert.equal(store.getSetting('notifications_paused'), '1')
  await chat.handle({ ...identity, scope: 'c2c', event: 'direct-request', text: request }, reply)
  assert.equal(store.nextSend()?.payload.text, 'I can make it.')
  assert.deepEqual(store.nextSend()?.payload.to, ['replies@example.net'])
  assert.match(replies[1], /已确认并排队/)
})

test('long summaries keep every generated point in one QQ notice', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const points = Array.from({ length: 7 }, (_, index) => '甲'.repeat(430) + `保留要点${index + 1}`)
  const model = async () => overviewMarkdown('【无需操作】', points)
  const assistant = new Assistant(store, { read: async () => ({ text: '正文', references: [], attachments: [] }) }, model)
  await assistant.analyzeOnce()
  const notices = []
  for (let notice = store.nextNotice(); notice; notice = store.nextNotice()) {
    notices.push(notice.text)
    store.finishNotice(notice, 'accepted')
  }
  assert.equal(notices.length, 1)
  assert.ok(notices[0].startsWith('【无需操作】\n') && !notices[0].includes('…'))
  for (const point of points) assert.ok(notices[0].includes(point), point.slice(-5))
})

test('literal reply text is preserved in a single complete long preview', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const chat = new Conversation(new Assistant(store, { read: async () => ({ text: '正文', references: [], attachments: [] }) },
    async () => assert.fail('literal reply should not be rewritten')), 'openid-1', 'me@163.com')
  const sent = []
  const reply = async text => { sent.push(text) }
  const literal = '用户自己写的内容\n'.repeat(800) + '完整结尾'
  await chat.handle({ ...identity, scope: 'c2c', text: '原样回复 M1：\n' + literal }, reply)
  assert.ok(store.latestDraft(1)?.payload.text === literal)
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes(literal))
  assert.equal(store.nextSend(), undefined)
  await new Promise(resolve => setTimeout(resolve, 5))
  await chat.handle({ ...identity, scope: 'c2c', event: 'confirmed-after-preview', text: '发送D1v1' }, reply)
  assert.ok(store.nextSend()?.payload.text === literal)
})

test('ambiguous email references let the agent ask a specific follow-up', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 2, [mail(1), mail(2)])
  const model = async () => JSON.stringify({ action: 'help', answer: '你指的是 M1 还是 M2？' })
  const chat = new Conversation(new Assistant(store, {}, model), 'openid-1', 'me@163.com')
  const replies = []
  await chat.handle({ ...identity, scope: 'c2c', text: '帮我找一下 M1 和 M2 里面那封' }, async text => { replies.push(text) })
  assert.match(replies[0], /M1.*M2/)
  assert.equal(store.getSetting('selected_mail'), undefined)
})

test('each classification appears first in both the delivered notification and the cached Markdown', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 3, [mail(1), mail(2), mail(3)])
  const labels = ['【需要操作 · 紧急】', '【需要操作 · 不紧急】', '【无需操作】']
  const assistant = new Assistant(store, {
    read: async item => ({ text: '邮件内容 ' + item.id, references: [], attachments: [] })
  }, async (_system, input) => {
    const source = JSON.parse(input)
    const id = Number(source.original.at(-1))
    return overviewMarkdown(labels[id - 1], ['收到来信'])
  })
  for (const [index, expected] of labels.entries()) {
    await assistant.analyzeOnce()
    const notice = store.nextNotice()
    assert.equal(notice.text.split('\n')[0], expected)
    assert.equal(store.mail(index + 1).summaryMarkdown, notice.text)
    store.finishNotice(notice, 'accepted')
  }
})

test('a deadline in a later part remains urgent when the whole-message summary is less urgent', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const result = await translate(store, 1, '长邮件', '正文'.repeat(2000) + '立即处理', async (_system, input) => {
    const source = JSON.parse(input)
    return JSON.stringify({
      language: 'zh', subject: '长邮件', points: ['摘要'], actions: [], deadlines: [], shouldReply: false,
      classification: source.text?.includes('立即处理') ? 'urgent_action' : 'no_action'
    })
  })
  assert.equal(result.classification, 'urgent_action')
})

test('explicit command prefixes cannot silently select the first of two drafts', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  store.createDraft(1, payload)
  store.createDraft(1, payload)
  const chat = new Conversation(new Assistant(store, {}, summaryModel), 'openid-1', 'me@163.com')
  const replies = []
  await chat.handle({ ...identity, scope: 'c2c', text: '取消 D1 和 D2' }, async text => { replies.push(text) })
  assert.match(replies[0], /D1.*D2/)
  assert.equal(store.latestDraft(1).state, 'DRAFT')
  assert.equal(store.latestDraft(2).state, 'DRAFT')
})

test('an unrelated natural request cannot cancel an approved draft through the model', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const draft = store.createDraft(1, payload)
  store.showConfirmation(draft, identity, 1000)
  store.approve(draft, { ...identity, event: 'explicit-approval' }, 1100)
  store.setSetting('selected_draft', '1')
  const model = async (_system, input) => {
    const source = JSON.parse(input)
    return JSON.stringify({ action: source.mails || source.request === '刚才那条先别寄出去' ? 'cancel' : 'help', target: 'D1' })
  }
  const chat = new Conversation(new Assistant(store, {}, model), 'openid-1', 'me@163.com')
  await chat.handle({ ...identity, scope: 'c2c', event: 'read-all', text: '看看今天有哪些邮件' }, async () => {})
  assert.equal(store.nextSend()?.state, 'QUEUED')
  await chat.handle({ ...identity, scope: 'c2c', event: 'cancel-request', text: '刚才那条先别寄出去' }, async () => {})
  assert.equal(store.latestDraft(1)?.state, 'CANCELLED')
})

test('a bare original command resolves a classified quoted mail without a model', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 2, [mail(1), mail(2)])
  store.saveBody(1, { text: 'The quoted body', references: [], attachments: [] })
  const chat = new Conversation(new Assistant(store, {}, async () => assert.fail('model is unavailable')), 'openid-1', 'me@163.com')
  const replies = []
  await chat.handle({ ...identity, scope: 'c2c', text: '原文', quotedText: '【需要操作 · 紧急】\nM1 · 测试' }, async text => { replies.push(text) })
  assert.match(replies.join('\n'), /The quoted body/)
})

test('the model stream uses the provider output limit without an assistant override', async t => {
  const { dshModel } = await import('../lib/index.js')
  const { store } = fixture(t)
  const requests = []
  const llm = { async *stream(request) {
    requests.push(request)
    yield { type: 'text-delta', index: 0, text: 'complete content' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const ctx = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } }
  const result = await dshModel(ctx, store, { modelCallsDaily: 5 }, new AbortController().signal)('test', 'message')
  assert.equal(result, 'complete content')
  assert.equal(requests.length, 1)
  assert.equal(Object.hasOwn(requests[0], 'maxTokens'), false)
})

test('a provider error does not trigger an immediate second model call', async t => {
  const { dshModel } = await import('../lib/index.js')
  const { store } = fixture(t)
  let calls = 0
  const llm = { async *stream() { calls++; yield { type: 'finish', reason: { kind: 'error' } } } }
  const ctx = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } }
  await assert.rejects(dshModel(ctx, store, { modelCallsDaily: 5 }, new AbortController().signal)('test', 'message'), /model_error/)
  assert.equal(calls, 1)
})

test('a Chinese test heading does not suppress translation of a predominantly English email', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const input = '系统测试\n\nPlease submit the completed release checklist within two hours.'
  const model = async (system, message) => {
    if (!system.includes('完整翻译')) return JSON.stringify({
      language: 'zh', subject: '上线检查', points: ['提交检查表'], actions: [], deadlines: [], shouldReply: true
    })
    assert.equal(JSON.parse(message).text, input)
    return '系统测试\n\n请在两小时内提交填好的上线检查表。'
  }
  const translated = await translate(store, 1, '系统测试', input, model)
  assert.match(translated.text, /请在两小时内提交/)
  assert.notEqual(translated.language, 'zh')
})

test('MIME attachments retain their exact decoded bytes separately from the mail body', async () => {
  const notice = Buffer.from('附件截止时间是今天下午三点。').toString('base64')
  const mime = [
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="fixture"', '',
    '--fixture', 'Content-Type: text/plain; charset=utf-8', '', 'Please see the attachment.',
    '--fixture', 'Content-Type: text/plain; charset=utf-8; name="requirements.txt"',
    'Content-Disposition: attachment; filename="requirements.txt"', 'Content-Transfer-Encoding: base64', '',
    notice, '--fixture--', ''
  ].join('\r\n')
  const body = await parseMail(Buffer.from(mime))
  assert.match(body.text, /Please see the attachment/)
  assert.doesNotMatch(body.text, /截止时间/)
  assert.equal(body.attachments[0].name, 'requirements.txt')
  assert.deepEqual(body.attachments[0].data, Buffer.from(notice, 'base64'))
})

test('original attachments feed the model and are sent to QQ only when requested', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const fileData = Buffer.from([0x00, 0xff, 0x60, 0x01, 0xf1])
  const body = {
    text: '请参考随信材料。原文专用内容不自动展示。',
    references: [],
    attachments: [
      { name: '上线核对.pdf', size: fileData.length, type: 'application/pdf', data: fileData },
      { name: '不可读取.bin', size: 5, type: 'application/octet-stream' }
    ]
  }
  let combined = false
  let mailReads = 0
  const model = async (_system, input, native) => {
    const source = JSON.parse(input)
    assert.equal(source.original, body.text)
    assert.equal(source.attachments[1].issue, '原始内容不可用')
    assert.deepEqual(native.files, [{ name: '上线核对.pdf', type: 'application/pdf', data: fileData }])
    combined = true
    return overviewMarkdown('【需要操作 · 紧急】', ['上线前完成密钥轮换'],
      ['上线核对.pdf：三点前确认轮换。', '不可读取.bin：原始内容不可用。'])
  }
  const assistant = new Assistant(store, { read: async () => { mailReads++; return body } }, model)
  await assistant.analyzeOnce()
  const notice = store.nextNotice()
  assert.equal(combined, true)
  assert.equal(notice.text.split('\n')[0], '【需要操作 · 紧急】')
  assert.match(notice.text, /上线核对\.pdf.*轮换/)
  assert.match(notice.text, /不可读取\.bin.*原始内容/)
  assert.doesNotMatch(notice.text, /原文专用内容不自动展示/)
  assert.equal(store.mail(1).body.attachments[0].data, undefined)
  store.finishNotice(notice, 'accepted')
  assert.equal(store.nextNotice(), undefined)

  const chat = new Conversation(assistant, 'openid-1', 'me@163.com')
  const replies = []
  const reply = async (text, file) => { replies.push({ text, file }) }
  await chat.handle({ ...identity, scope: 'c2c', text: '全文 M1' }, reply)
  assert.match(replies[0].text, /原文专用内容不自动展示/)
  await chat.handle({ ...identity, event: 'read-file', scope: 'c2c', text: '附件 M1 1' }, reply)
  assert.equal(mailReads, 2)
  assert.equal(replies[1].file.name, '上线核对.pdf')
  assert.deepEqual(replies[1].file.data, fileData)
})

test('retries a transient Files API failure without uploading successful attachments again', async t => {
  const { NativeFileError } = await import('../lib/deepseek-files.js')
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const files = ['first.pdf', 'second.pdf'].map(name => ({
    name, type: 'application/pdf', size: 15, data: Buffer.from('example ' + name)
  }))
  const sent = []
  const model = async (_system, _input, file) => {
    if (file) {
      sent.push(file.name)
      if (file.name === 'second.pdf') throw new NativeFileError('model_file_temporary', '文件接口暂不可用', true)
    }
    return JSON.stringify({ language: 'zh', subject: '示例', points: ['要点'], actions: [],
      deadlines: [], shouldReply: false, classification: 'no_action' })
  }
  await assert.rejects(translate(store, 1, '示例', '正文', model, undefined, files), /文件接口暂不可用/)
  const result = await translate(store, 1, '示例', '正文', model, undefined, files, true)
  assert.deepEqual(sent, ['first.pdf', 'second.pdf', 'second.pdf'])
  assert.match(result.attachmentSummaries[1].reason, /暂不可用/)
})

test('an invalid attachment summary can be retried without losing the mail summary', async t => {
  const { store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  const data = Buffer.from('example')
  const files = [{ name: 'report.pdf', type: 'application/pdf', size: data.length, data }]
  const model = async (_system, _input, file) => file ? '无法生成概要' : JSON.stringify({
    language: 'zh', subject: '示例', points: ['正文要点'], actions: [], deadlines: [], shouldReply: false
  })
  await assert.rejects(translate(store, 1, '示例', '正文', model, undefined, files), { code: 'invalid_attachment_summary' })
  const result = await translate(store, 1, '示例', '正文', model, undefined, files, true)
  assert.deepEqual(result.points, ['正文要点'])
  assert.match(result.attachmentSummaries[0].reason, /概要格式无效/)
})

test('updating a legacy database suppresses already queued automatic full-text notices', async t => {
  const { DatabaseSync } = await import('node:sqlite')
  const { path, store } = fixture(t)
  store.baseline('1', 0)
  store.enqueue('1', 1, [mail(1)])
  store.queueNotice('mail/1', 1, 'M1 · Hello\n概要内容\n\n中文全文\n这是旧版本排队的全文')
  store.queueNotice('mail/1/txt', 1, '另一份全文', 'M1-zh.txt')
  store.close()
  const legacy = new DatabaseSync(path)
  legacy.exec(`ALTER TABLE mails DROP COLUMN summary_markdown;
    ALTER TABLE mails DROP COLUMN original_translation;
    ALTER TABLE notices DROP COLUMN is_markdown;
    PRAGMA user_version=2`)
  legacy.prepare('UPDATE mails SET translation=? WHERE id=1').run(JSON.stringify({ text: '一份已有译文' }))
  legacy.close()
  const updated = new Store(path)
  try {
    const summary = updated.nextNotice()
    assert.equal(summary.text, 'M1 · Hello\n概要内容')
    assert.equal(updated.mail(1).originalTranslation, '一份已有译文')
    updated.finishNotice(summary, 'accepted')
    assert.equal(updated.nextNotice(), undefined)
  } finally { updated.close() }
})
