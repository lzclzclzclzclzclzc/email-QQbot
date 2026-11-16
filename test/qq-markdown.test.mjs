import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError } from '@tencent-connect/qqbot-nodejs'
import { sendQqMessage, sendQqText } from '../lib/qq-markdown.js'

const target = { scope: 'c2c', targetId: 'owner', msgId: 'inbound' }
const receipt = { id: 'sent', timestamp: 123, ext_info: { ref_idx: 'reference' } }
const path = '/v2/users/owner/messages'

test('formats a heading and bullets while displaying email markup literally', async () => {
  const bot = {
    async sendMarkdown(peer, content) {
      assert.deepEqual(peer, target)
      assert.equal(content, '**【需要操作 · 紧急】**  \nM12 · 检查 \\[附件\\]  \n发件人 王敏\n\n' +
        '- 核对 \\*金额\\*、日期\n- \\!\\[图片\\](https\u200b://example.test/a)\n\n' +
        '中文全文  \n\\<img src="x"\\>  \n1\\. 第一行  \nwww\u200b.example.test')
      return receipt
    },
    async sendText() { assert.fail('unexpected text send') },
  }
  const input = '【需要操作 · 紧急】\r\nM12 · 检查 [附件]\n发件人 王敏\n' +
    '• 核对 *金额*、日期\n• ![图片](https://example.test/a)\n中文全文\n<img src="x">\n1. 第一行\nwww.example.test'
  assert.deepEqual(await sendQqText(bot, target, input), { message: receipt, format: 'markdown' })
})

test('sends generated summary Markdown unchanged, including headings and nested lists', async () => {
  const input = '# 【需要操作 · 紧急】\n\n## M12 · 续费通知\n\n' +
    '1. **确认金额**  \n   - 待确认：`¥128`\n   - 截止：周五\n\n' +
    '## 邮件摘要\n' + '这是一封续费通知。'.repeat(800) + '\n完整结尾。'
  const bot = {
    async sendMarkdown(peer, content) {
      assert.deepEqual(peer, target)
      assert.ok(content === input, 'Markdown changed before sending')
      return receipt
    },
    async sendText() { assert.fail('unexpected text send') },
    async sendFile() { assert.fail('unexpected file send') },
  }
  assert.deepEqual(await sendQqMessage(bot, target, input, true, true), { message: receipt, format: 'markdown' })
})

test('retries definitive Markdown rejection once as text on the original passive target', async () => {
  const input = '原标题\n• *原文*'
  for (const [code, message] of [
    [40034012, '不允许发送原生 markdown'],
    [40034090, '渲染失败'],
    [50056, '不允许发送 markdown content'],
    [undefined, 'Markdown content exceeds maximum length'],
  ]) {
    const formats = []
    const bot = {
      async sendMarkdown(peer) {
        assert.deepEqual(peer, target)
        formats.push('markdown')
        throw new ApiError('Bad request', 400, path, code, message)
      },
      async sendText(peer, content) {
        assert.deepEqual(peer, target)
        assert.equal(content, input)
        formats.push('text')
        return receipt
      },
    }
    assert.deepEqual(await sendQqText(bot, target, input), { message: receipt, format: 'text', markdownRejected: true })
    assert.deepEqual(formats, ['markdown', 'text'])
  }
})

test('propagates timeout, server failure, rate limit and unrelated rejection without a second send', async () => {
  for (const error of [
    new DOMException('Timeout', 'TimeoutError'),
    new ApiError('Timeout', 408, path, 40034012, 'Markdown not permitted'),
    new ApiError('Unavailable', 503, path, 40034012, 'Markdown not permitted'),
    new ApiError('Rate limit', 429, path, 40034012, 'Markdown not permitted'),
    new ApiError('Expired', 400, path, 40034005, 'msg_id 已过期'),
    new ApiError('Rate limit', 400, path, 22009, 'Markdown message rate limit exceeded'),
  ]) {
    const bot = {
      async sendMarkdown() { throw error },
      async sendText() { assert.fail('unexpected text send') },
    }
    await assert.rejects(sendQqText(bot, target, '摘要'), actual => actual === error)
  }
})

test('sends full text without a local Markdown length limit', async () => {
  const calls = []
  const bot = {
    async sendMarkdown(peer, content) { calls.push([peer, content]); return receipt },
    async sendText(peer, content) { calls.push([peer, content]); return receipt },
  }
  const long = '*'.repeat(2000)
  assert.deepEqual(await sendQqText(bot, target, '原标题\n• 原文', false), { message: receipt, format: 'text' })
  assert.deepEqual(await sendQqText(bot, target, long), { message: receipt, format: 'markdown' })
  assert.deepEqual(calls, [[target, '原标题\n• 原文'], [target, '\\*'.repeat(2000)]])
})

test('QQ length rejection sends the entire original summary in one TXT message', async () => {
  const sizeError = new ApiError('Bad request', 400, path, 40054007, '消息长度超限')
  const content = '# 【需要操作 · 紧急】\n\n## M12 · 详情\n' + '概要正文'.repeat(2000) + '不能丢掉的结尾'
  let fileSends = 0
  const bot = {
    async sendMarkdown(_peer, text) { assert.ok(text === content, 'Markdown changed before sending'); throw sizeError },
    async sendText(_peer, text) { assert.ok(text === content, 'Text changed before sending'); throw sizeError },
    async sendFile(peer, file, options) {
      assert.deepEqual(peer, target)
      assert.ok(file.buffer.toString('utf8') === content, 'TXT content changed before sending')
      assert.match(options.content, /^【需要操作 · 紧急】\nM12\n/)
      fileSends++
      return { message: receipt }
    }
  }
  assert.deepEqual(await sendQqMessage(bot, target, content, true, true), { message: receipt, format: 'file' })
  assert.equal(fileSends, 1)
})
