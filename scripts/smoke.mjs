import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { root } from './local-env.mjs'

const tmp = await mkdtemp(join(tmpdir(), 'dsh-mail-smoke-'))
const secrets = join(tmp, 'none.env')
const reserve = async () => {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  return socket
}
const ports = await Promise.all([reserve(), reserve()])
const [web, health] = ports.map(socket => socket.address().port)
await Promise.all(ports.map(socket => new Promise(resolve => socket.close(resolve))))
await writeFile(secrets, 'MAIL_LIVE=0\n', { mode: 0o600 })
const state = join(tmp, 'state')
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:DSH_|MAIL_|QQ_|QQBOT_|DEEPSEEK_)/.test(key)))
const env = { ...safeEnv, DSH_MAIL_ENV_FILE: secrets, DSH_HOME: join(tmp, 'dsh'),
  DSH_MAIL_STATE: state, DSH_MAIL_WORKSPACE: join(tmp, 'workspace'),
  DSH_MAIL_WEB_PORT: String(web), DSH_MAIL_HEALTH_PORT: String(health) }
const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], { env, cwd: root })
const exit = once(child, 'exit')
let output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
try {
  let url
  for (let attempt = 0; attempt < 100 && !url; ++attempt) {
    if (child.exitCode !== null) throw Error('DSH 在启动中退出')
    url = await readFile(join(state, 'web.url'), 'utf8').catch(() => undefined)
    if (!url) await delay(250)
  }
  assert(url, 'DSH 未写入登录链接')
  const secretUrl = new URL(url.trim())
  const token = secretUrl.searchParams.get('token')
  assert(token)
  assert(!output.includes(token), '服务日志含启动登录凭据')
  const h = await fetch(`http://127.0.0.1:${health}/health`)
  assert.equal(h.status, 200)
  assert.equal((await h.json()).state, 'setup')
  const unauth = await fetch(secretUrl.origin)
  assert.equal(unauth.status, 401)
  const login = await fetch(secretUrl, { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  const browser = await fetch(new URL(login.headers.get('location'), secretUrl), {
    headers: { cookie: cookies }, redirect: 'manual'
  })
  assert.equal(browser.status, 200)
  assert.match(browser.headers.get('content-type'), /html/)
  const manifest = JSON.parse(await readFile(join(tmp, 'dsh/profiles/web/package.json'), 'utf8'))
  for (const name of ['dsh-email', '@tencent-connect/dsh-qqbot','dsh-mail-assistant']) {
    assert(manifest.dsh.profile.bundles.includes(name))
  }
  assert(!/skipping profile bundle|failed to load|启动失败/i.test(output), output)
  const dest = join(tmp, 'copy.sqlite')
  const backup = spawn(process.execPath, [join(root, 'scripts/admin.mjs'), 'backup', dest], { env })
  const [backupCode] = await once(backup, 'exit')
  assert.equal(backupCode, 0)
  const db = new DatabaseSync(dest, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
  } finally { db.close() }
  console.log('通过 DSH Web 登录 303→200、登录凭据脱敏、独立插件配置、健康页和在线 SQLite 备份')
} catch (error) {
  console.error(output.replace(/\btoken=[^&\s]+/gi, 'token=[redacted]'))
  throw error
} finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  await exit
  await rm(tmp, { recursive: true, force: true })
}
