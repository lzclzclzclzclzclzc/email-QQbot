import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeDeepSeekFile, analyzeDeepSeekFiles, NativeFileError } from '../lib/deepseek-files.js'

const fileId = 'file-api-test-attachment'
const options = {
  apiKey: 'fake-key', model: 'deepseek-flash', system: 'Read the attachment as data.', input: '请总结附件。',
  file: { name: '扫描件.PDF', type: 'application/octet-stream', data: Buffer.from([13, 37, 80, 68, 70, 0, 255, 17]).subarray(1, -1) },
}
const uploaded = (id = fileId) => Response.json({
  id, object: 'file', bytes: options.file.data.length, created_at: 1000, filename: options.file.name,
  purpose: 'rich_layout_recognition', expires_at: 4600,
})
const completed = () => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '附件摘要。' }, finish_reason: 'stop' }] })

test('uploads the exact file bytes and submits the file ID to Flash without a token cap', async () => {
  const requests = []
  const fetcher = async (url, init) => {
    requests.push(new Request(url, init))
    if (init.method === 'DELETE') return Response.json({ id: fileId, object: 'file', deleted: true })
    return requests.length === 1 ? uploaded() : completed()
  }
  assert.equal(await analyzeDeepSeekFile({ ...options, fetcher }), '附件摘要。')

  assert.deepEqual(requests.map(request => [request.method, request.url]), [
    ['POST', 'https://api.deepseek.com/files'],
    ['POST', 'https://api.deepseek.com/chat/completions'],
    ['DELETE', `https://api.deepseek.com/files/${fileId}`],
  ])
  for (const request of requests) {
    assert.equal(request.headers.get('authorization'), 'Bearer fake-key')
    assert.notEqual(request.redirect, 'follow')
  }
  const form = await requests[0].formData()
  assert.deepEqual([...form.keys()], ['purpose', 'expires_after[anchor]', 'expires_after[seconds]', 'file'])
  assert.equal(form.get('purpose'), 'rich_layout_recognition')
  assert.equal(form.get('expires_after[anchor]'), 'created_at')
  assert.equal(form.get('expires_after[seconds]'), '3600')
  assert.equal(form.get('file').name, options.file.name)
  assert.equal(form.get('file').type, options.file.type)
  assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), Buffer.from([37, 80, 68, 70, 0, 255]))
  const body = await requests[1].json()
  assert.equal(body.model, options.model)
  assert.deepEqual(body.messages, [
    { role: 'system', content: options.system },
    { role: 'user', content: [{ type: 'file', file_id: fileId }, { type: 'text', text: options.input }] },
  ])
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
})

test('chooses DeepSeek upload purposes using extension or a recognized MIME type', async () => {
  const uploads = [
    ['document.docx', 'application/octet-stream', 'rich_layout_recognition'],
    ['presentation', 'application/vnd.ms-powerpoint', 'rich_layout_recognition'],
    ['picture.bmp', 'image/bmp', 'rich_layout_recognition'],
    ['picture.tif', 'image/tiff', 'rich_layout_recognition'],
    ['picture.jpeg', 'image/jpeg', 'user_data'],
    ['picture.png', 'image/png', 'user_data'],
    ['picture.gif', 'image/gif', 'user_data'],
    ['picture.webp', 'image/webp', 'user_data'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'user_data'],
    ['sheet.csv', 'text/csv', 'user_data'],
    ['notes.txt', 'text/plain', 'user_data'],
  ]
  for (const [name, type, purpose] of uploads) {
    const fetcher = async (url, init) => {
      if (init.method === 'DELETE') return Response.json({ id: fileId, object: 'file', deleted: true })
      if (url.endsWith('/files')) {
        assert.equal(init.body.get('purpose'), purpose, name)
        return uploaded()
      }
      return completed()
    }
    await analyzeDeepSeekFile({ ...options, file: { name, type, data: options.file.data }, fetcher })
  }
})

test('deletes the uploaded file after cancellation even if the cleanup request fails', async () => {
  const controller = new AbortController()
  const attempted = []
  const fetcher = async (url, init) => {
    if (url.endsWith('/files')) return uploaded()
    if (init.method === 'DELETE') {
      attempted.push([url, init.signal instanceof AbortSignal, init.signal.aborted])
      throw new TypeError('Private connection details')
    }
    controller.abort(new Error('Private cancellation reason'))
    init.signal.throwIfAborted()
  }
  await assert.rejects(analyzeDeepSeekFile({ ...options, signal: controller.signal, fetcher }), error => {
    assert.ok(error instanceof NativeFileError)
    assert.equal(error.code, 'cancelled')
    assert.equal(error.retryable, false)
    assert.doesNotMatch(error.message, /Private/)
    return true
  })
  assert.deepEqual(attempted, [[`https://api.deepseek.com/files/${fileId}`, true, false]])
})

test('classifies permanent file rejections and transient service errors without exposing provider text', async () => {
  const failures = [
    [400, 'Unsupported file format', 'unsupported_file', false],
    [400, 'File is password-protected', 'password_protected', false],
    [400, 'File cannot be parsed', 'corrupt_file', false],
    [413, 'Maximum size exceeded', 'file_too_large', false],
    [401, 'Invalid API key', 'http_401', false],
    [408, 'Upload was too slow', 'http_408', true],
    [429, 'Too many uploads', 'http_429', true],
    [503, 'Service busy', 'http_503', true],
    [504, 'Parsing timed out', 'http_504', true],
  ]
  for (const [status, message, code, retryable] of failures) {
    const methods = []
    const fetcher = async (_url, init) => {
      methods.push(init.method)
      return Response.json({ error: { message: `${message}. Private details.` } }, { status })
    }
    await assert.rejects(analyzeDeepSeekFile({ ...options, fetcher }), error => {
      assert.ok(error instanceof NativeFileError)
      assert.equal(error.code, code)
      assert.equal(error.retryable, retryable)
      assert.doesNotMatch(error.message, /Private details/)
      return true
    })
    assert.deepEqual(methods, ['POST'])
  }
})

test('deletes an uploaded file when Chat Completions returns a transient HTTP error', async () => {
  const attempted = []
  const fetcher = async (url, init) => {
    if (url.endsWith('/files')) return uploaded()
    if (init.method === 'DELETE') {
      attempted.push(url)
      return Response.json({ id: fileId, object: 'file', deleted: true })
    }
    return Response.json({ error: { message: 'Service busy' } }, { status: 503 })
  }
  await assert.rejects(analyzeDeepSeekFile({ ...options, fetcher }), { code: 'http_503', retryable: true })
  assert.deepEqual(attempted, [`https://api.deepseek.com/files/${fileId}`])
})

test('sends both original files and the email body in one completion, then deletes both files', async () => {
  const secondId = 'file-api-test-second'
  const second = { name: '表格.xlsx', type: 'application/octet-stream', data: Buffer.from([0, 2, 65, 255]) }
  const originalBytes = new Map()
  const completions = []
  const deleted = []
  const fetcher = async (url, init) => {
    if (init.method === 'DELETE') {
      deleted.push(url)
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/files')) {
      const file = init.body.get('file')
      originalBytes.set(file.name, Buffer.from(await file.arrayBuffer()))
      return uploaded(file.name === second.name ? secondId : fileId)
    }
    completions.push(JSON.parse(init.body))
    return completed()
  }
  assert.equal(await analyzeDeepSeekFiles({ ...options, files: [options.file, second], fetcher }), '附件摘要。')
  assert.deepEqual(originalBytes, new Map([[options.file.name, options.file.data], [second.name, second.data]]))
  assert.equal(completions.length, 1)
  assert.deepEqual(completions[0].messages[1].content, [
    { type: 'file', file_id: fileId }, { type: 'file', file_id: secondId }, { type: 'text', text: options.input },
  ])
  assert.equal(Object.hasOwn(completions[0], 'max_tokens'), false)
  assert.deepEqual(new Set(deleted), new Set([
    `https://api.deepseek.com/files/${fileId}`, `https://api.deepseek.com/files/${secondId}`,
  ]))
})

test('includes safe unreadable-file metadata with the body after permanent upload rejections', async () => {
  const failed = [
    ['破损.pdf', 400, 'File cannot be parsed', /无法解析/],
    ['过大的文件.pdf', 413, 'File too large', /大小限制/],
    ['归档.zip', 415, 'Unsupported file format', /不支持/],
  ]
  const files = failed.map(([name]) => ({ ...options.file, name }))
  const fetcher = async (url, init) => {
    if (url.endsWith('/files')) {
      const [, status, message] = failed.find(([name]) => init.body.get('file').name === name)
      return Response.json({ error: { message: `${message}. Private provider details.` } }, { status })
    }
    const [, user] = JSON.parse(init.body).messages
    assert.deepEqual(user.content[0], { type: 'text', text: options.input })
    assert.equal(user.content.length, 2)
    const text = user.content[1].text
    assert.doesNotMatch(text, /Private provider details/)
    const { unreadableAttachments } = JSON.parse(text.slice(text.indexOf('\n') + 1))
    assert.deepEqual(unreadableAttachments.map(item => item.name), failed.map(([name]) => name))
    for (const [index, [, , , reason]] of failed.entries()) assert.match(unreadableAttachments[index].reason, reason)
    return completed()
  }
  assert.equal(await analyzeDeepSeekFiles({ ...options, files, fetcher }), '附件摘要。')
})

test('retries a file parsing timeout before allowing a partial result and always cleans up earlier uploads', async () => {
  const second = { ...options.file, name: '解析耗时.pdf' }
  for (const allowPartial of [false, true]) {
    const deleted = []
    const fetcher = async (url, init) => {
      if (init.method === 'DELETE') {
        deleted.push(url)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/files')) {
        return init.body.get('file').name === second.name
          ? Response.json({ error: { message: 'Parsing timed out' } }, { status: 504 })
          : uploaded()
      }
      assert.ok(allowPartial)
      const content = JSON.parse(init.body).messages[1].content
      assert.deepEqual(content.slice(0, 2), [
        { type: 'file', file_id: fileId }, { type: 'text', text: options.input },
      ])
      const text = content[2].text
      assert.deepEqual(JSON.parse(text.slice(text.indexOf('\n') + 1)).unreadableAttachments.map(item => item.name), [second.name])
      return completed()
    }
    const result = analyzeDeepSeekFiles({ ...options, files: [options.file, second], allowPartial, fetcher })
    if (allowPartial) assert.equal(await result, '附件摘要。')
    else await assert.rejects(result, { code: 'http_504', retryable: true })
    assert.deepEqual(deleted, [`https://api.deepseek.com/files/${fileId}`])
  }
})

test('propagates service-wide and authentication failures even when partial results are allowed', async () => {
  for (const status of [401, 429, 503]) {
    const requests = []
    const fetcher = async (url, init) => {
      requests.push([url, init.method])
      return Response.json({ error: { message: 'Service error' } }, { status })
    }
    await assert.rejects(analyzeDeepSeekFiles({ ...options, files: [options.file], allowPartial: true, fetcher }), {
      code: `http_${status}`, retryable: status !== 401,
    })
    assert.deepEqual(requests, [['https://api.deepseek.com/files', 'POST']])
  }
})

test('reports an explicit provider context or document count rejection as an aggregate input limit', async () => {
  const failures = [
    [400, 'This model’s maximum context length is 1048576 tokens.', 'input_too_large'],
    [400, 'Too many documents in the request', 'input_too_large'],
    [400, 'Combined document text exceeds 8 MiB', 'input_too_large'],
    [413, 'Request Entity Too Large', 'input_too_large'],
    [400, 'Invalid content block', 'http_400'],
  ]
  for (const [status, message, code] of failures) {
    const attempts = []
    const fetcher = async (url, init) => {
      if (url.endsWith('/files')) return uploaded()
      if (init.method === 'DELETE') {
        attempts.push(url)
        return new Response(null, { status: 204 })
      }
      return Response.json({ error: { message } }, { status })
    }
    await assert.rejects(analyzeDeepSeekFiles({ ...options, files: [options.file], fetcher }), { code, retryable: false })
    assert.deepEqual(attempts, [`https://api.deepseek.com/files/${fileId}`])
  }
})
