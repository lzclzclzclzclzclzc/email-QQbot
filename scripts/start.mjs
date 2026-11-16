import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { loadSecrets, local, root, setupLocal } from './local-env.mjs'
import { readConfig } from '../lib/config.js'

process.umask(0o077)
if (process.argv[2] === '--init') {
  setupLocal()
  process.exit(0)
}
loadSecrets()

const env = process.env
if (!env.DSH_HOME) env.DSH_HOME = join(local, 'dsh')
env.DSH_HOME = resolve(env.DSH_HOME)
env.DSH_MAIL_STATE ||= join(local, 'state')
env.DSH_MAIL_MANAGED = '1'
env.TZ = 'Asia/Shanghai'
const config = readConfig()
const work = resolve(env.DSH_MAIL_WORKSPACE || join(local, 'workspace'))
const profileDir = join(env.DSH_HOME, 'profiles', 'web')
const manifestPath = join(profileDir, 'package.json')
const launcher = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const webPort = Number(env.DSH_MAIL_WEB_PORT || 3080)
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535 || webPort === config.healthPort) {
  throw Error('Web 和健康页需要两个不同的有效本机端口')
}
for (const dir of [work, config.stateDir, env.DSH_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 })

const managed = new Map([
  ['@tencent-connect/dsh-qqbot', join(root, 'node_modules', '@tencent-connect', 'dsh-qqbot')],
  ['dsh-email', join(root, 'node_modules', 'dsh-email')],
  ['dsh-mail-assistant', root]
])
const gateway = readFileSync(join(managed.get('@tencent-connect/dsh-qqbot'), 'lib', 'gateway', 'bootstrap.js'), 'utf8')
if (!gateway.includes('DSH_MAIL_ASSISTANT_0_1')) throw Error('QQ 网关补丁未就绪，请运行 npm ci --omit=dev')
const marker = join(env.DSH_HOME, '.dsh-mail-profile')
if (!existsSync(marker) && existsSync(manifestPath))
  throw Error('DSH_HOME 已有其他 Web profile，请使用邮件助手专用目录')
if (!existsSync(marker)) writeFileSync(marker, 'dsh-mail-assistant\n', { flag: 'wx' })
if (!existsSync(manifestPath)) {
  const result = spawnSync(process.execPath, [launcher, '--profile', 'web', '--dump-default-config'],
    { env, cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })
  if (result.status !== 0) throw Error('DSH Web profile 初始化失败')
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const manifestBefore = JSON.stringify(manifest)
manifest.dependencies ??= {}
const bundles = manifest.dsh.profile.bundles
for (const [name, dir] of managed) {
  const parts = name.split('/')
  const dirName = join(profileDir, 'node_modules', ...parts.slice(0, -1))
  mkdirSync(dirName, { recursive: true })
  const link = join(dirName, parts.at(-1))
  if (!existsSync(link)) symlinkSync(dir, link, 'dir')
  if (realpathSync(link) !== realpathSync(dir)) throw Error('专用 profile 的插件路径已变化 ' + name)
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  manifest.dependencies[name] = meta.version
  if (!bundles.includes(name)) bundles.push(name)
}
if (manifestBefore !== JSON.stringify(manifest)) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const child = spawn(process.execPath,
  [launcher, '--profile', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--no-open'],
  { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
const urlPath = join(config.stateDir, 'web.url')
let wroteUrl = false
for (const stream of [child.stdout, child.stderr]) {
  createInterface({ input: stream }).on('line', line => {
    if (line.startsWith('dsh web: http')) {
      const candidate = line.slice('dsh web: '.length).trim()
      const url = new URL(candidate)
      if (url.hostname === '127.0.0.1' && Number(url.port) === webPort) {
        writeFileSync(urlPath, candidate + '\n', { mode: 0o600 })
        wroteUrl = true
        console.log('[dsh-mail] DSH 登录链接已保存到 ' + urlPath)
      }
    } else if (/\b(?:token|auth_token|access_token|api_key|client_secret|appSecret)=/i.test(line)) {
      console.log('[dsh-mail] DSH 输出已省略敏感字段')
    } else {
      (stream === child.stderr ? process.stderr : process.stdout).write(line + '\n')
    }
  })
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => {
  if (wroteUrl && existsSync(urlPath)) unlinkSync(urlPath)
  process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1)
})
