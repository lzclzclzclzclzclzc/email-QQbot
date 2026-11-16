import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { readConfig } from '../lib/config.js'
import * as mail from '../lib/mail.js'

const qq = { MAIL_LIVE: '1', QQ_OWNER_OPENID: 'test-owner', QQBOT_APPID: 'test-app', QQBOT_SECRET: 'test-secret' }

test('existing 163 login and implicit TLS settings still work', () => {
  const config = readConfig({ ...qq, MAIL_USER: 'reader@163.com', MAIL_AUTH_CODE: 'existing-code' })
  assert.equal(config.mailReady, true)
  assert.deepEqual([config.imap.host, config.imap.port, config.imap.secure], ['imap.163.com', 993, true])
  assert.deepEqual([config.smtp.host, config.smtp.port, config.smtp.secure], ['smtp.163.com', 465, true])
  assert.equal(config.imap.login.password, 'existing-code')
  assert.equal(config.smtp.login.password, 'existing-code')
})

test('non-163 accounts require actual mail hosts before live setup can start', () => {
  assert.throws(() => readConfig({ ...qq, MAIL_USER: 'reader@example.org', MAIL_PASSWORD: 'test-password' }), /IMAP.*SMTP/)
  const config = readConfig({ MAIL_USER: 'reader@example.org' })
  assert.equal(config.mailReady, false)
  assert.throws(() => readConfig({ MAIL_IMAP_HOST: 'https://imap.example.org/path' }), /MAIL_IMAP_HOST/)
  assert.throws(() => readConfig({ MAIL_SMTP_PORT: '65536' }), /MAIL_SMTP_PORT/)
})

test('generic transport uses each host, login and TLS mode and rereads rotating OAuth tokens', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mail-token-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'first-access-token\n', { mode: 0o600 })
  const config = readConfig({
    ...qq, MAIL_USER: 'reader@example.org', MAIL_IMAP_HOST: 'imap.example.net', MAIL_SMTP_HOST: 'mx.example.net',
    MAIL_IMAP_PORT: '143', MAIL_IMAP_USER: 'reader', MAIL_IMAP_ACCESS_TOKEN_FILE: tokenFile,
    MAIL_SMTP_USER: 'smtp-user', MAIL_SMTP_PORT: '2465', MAIL_SMTP_SECURITY: 'tls', MAIL_SMTP_PASSWORD: ' separate-password ',
  })
  const imap = []
  const smtp = []
  t.mock.method(ImapFlow.prototype, 'connect', async function () { imap.push(this.options) })
  t.mock.method(ImapFlow.prototype, 'list', async () => [{ specialUse: '\\Sent', path: 'Sent' }])
  t.mock.method(ImapFlow.prototype, 'close', () => {})
  t.mock.method(nodemailer, 'createTransport', options => {
    smtp.push(options)
    return { verify: async () => true, close() {} }
  })
  const client = new mail.ImapSmtpMailbox(config)
  t.after(() => client.close())
  assert.deepEqual(await client.verify(), ['Sent'])
  writeFileSync(tokenFile, 'next-access-token\n')
  await client.verify()
  assert.deepEqual(imap.map(({host, port, secure, doSTARTTLS, auth}) => [host, port, secure, doSTARTTLS, auth]), [
    ['imap.example.net', 143, false, true, { user: 'reader', accessToken: 'first-access-token' }],
    ['imap.example.net', 143, false, true, { user: 'reader', accessToken: 'next-access-token' }]
  ])
  assert.deepEqual(smtp.map(({host, port, secure, requireTLS, auth}) => [host, port, secure, requireTLS, auth]), [
    ['mx.example.net', 2465, true, false, { user: 'smtp-user', pass: ' separate-password ' }],
    ['mx.example.net', 2465, true, false, { user: 'smtp-user', pass: ' separate-password ' }]
  ])
  const oauthClient = new mail.ImapSmtpMailbox(readConfig({
    ...qq, MAIL_USER: 'reader@example.org', MAIL_ACCESS_TOKEN: 'shared-token',
    MAIL_IMAP_HOST: 'imap.example.net', MAIL_SMTP_HOST: 'mx.example.net', MAIL_SMTP_PORT: '587',
  }))
  t.after(() => oauthClient.close())
  await oauthClient.verify()
  assert.deepEqual(imap.at(-1).auth, { user: 'reader@example.org', accessToken: 'shared-token' })
  assert.equal(smtp.at(-1).requireTLS, true)
  assert.deepEqual(smtp.at(-1).auth, { type: 'OAuth2', user: 'reader@example.org', accessToken: 'shared-token' })
})
