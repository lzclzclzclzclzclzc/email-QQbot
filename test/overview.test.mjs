import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Assistant } from '../lib/assistant.js'
import { Conversation } from '../lib/conversation.js'
import { Store } from '../lib/store.js'

const markdown = (point) => `【需要操作 · 紧急】
# 发布检查
## 1. 概要
- ${point}
## 2. 待办
- 今天确认。
## 3. 附件
- schedule.pdf：更新后的会议地点是 Cedar 3B。
- requirements.docx：审批码是 ORCHID。
## 4. 助手建议
先核对会议时间。`

test('one native overview request includes the body and every original file, and edits are cached independently', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-overview-'))
  const store = new Store(join(directory, 'mail.sqlite'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.baseline('1', 0)
  store.enqueue('1', 1, [{ uid: 1, received: Date.now(), subject: '发布检查', from: ['test@example.net'],
    replyTo: [], to: ['me@163.com'], cc: [], size: 900 }])
  const originals = [
    { name: 'schedule.pdf', size: 3, type: 'application/pdf', data: Buffer.from([1, 2, 3]) },
    { name: 'requirements.docx', size: 2, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.from([0, 255]) },
  ]
  let calls = 0
  let reads = 0
  const model = async (system, input, native) => {
    calls++
    const context = JSON.parse(input)
    if (system.includes('## 1. 概要')) {
      assert.equal(context.original, 'Please review the materials.')
      assert.deepEqual(native.files.map(({ name, type, data }) => ({ name, type, data })),
        originals.map(({ name, type, data }) => ({ name, type, data })))
      return markdown(context.request ? '先写审批码和时限。' : '会议在 Cedar 3B，审批码 ORCHID。')
    }
    assert.match(system, /翻译/)
    return context.request ? '请核查材料。' : '请审阅材料。'
  }
  const app = new Assistant(store, { read: async () => {
    reads++
    return { text: 'Please review the materials.', references: [], attachments: originals }
  } }, model)
  const chat = new Conversation(app, 'owner', 'me@163.com')
  const replies = []
  const ask = (event, text) => chat.handle({ scope: 'c2c', owner: 'owner', chat: 'owner', event, text },
    async (content, file, isMarkdown) => { replies.push({content, file, isMarkdown}) })
  assert.ok(await app.analyzeOnce())
  assert.equal(calls, 2)
  const initial = markdown('会议在 Cedar 3B，审批码 ORCHID。')
  const notice = store.nextNotice()
  assert.equal(notice.text, initial)
  assert.equal(notice.is_markdown, 1)
  store.finishNotice(notice, 'accepted')
  await ask('overview', '概要 M1')
  assert.equal(replies.at(-1).content, initial)
  assert.equal(replies.at(-1).isMarkdown, true)
  await ask('translation', '译文 M1')
  assert.match(replies.at(-1).content, /请审阅材料/)
  assert.equal(reads, 1)
  assert.equal(calls, 2)
  await ask('edit-overview', '改概要 M1：先写审批码和时限')
  assert.equal(store.mail(1).summaryMarkdown, markdown('先写审批码和时限。'))
  assert.equal(store.mail(1).originalTranslation, '请审阅材料。')
  assert.equal(store.nextNotice(), undefined)
  await ask('edit-translation', '改译文 M1：用核查代替审阅')
  assert.equal(store.mail(1).originalTranslation, '请核查材料。')
  assert.equal(calls, 4)
  await ask('reopen-overview', '概要 M1')
  assert.equal(replies.at(-1).content, store.mail(1).summaryMarkdown)
  await ask('reopen-translation', '译文 M1')
  assert.match(replies.at(-1).content, /请核查材料/)
  assert.equal(calls, 4)
})
