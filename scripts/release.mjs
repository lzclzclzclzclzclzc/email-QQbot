import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { root } from './local-env.mjs'

const dist = join(root, 'dist')
const file = join(dist, 'release.json')
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'))
const manifest = readJSON(join(root, 'package.json'))
const lock = readJSON(join(root, 'package-lock.json'))
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item => {
  const path = join(dir, item.name)
  return item.isDirectory() ? walk(path) : [path]
})
const input = [
  'package.json', 'package-lock.json', 'config.schema.json', 'cordis.patch.yml',
  'lib', 'scripts', 'deploy', 'migrations',
  'node_modules/@tencent-connect/dsh-qqbot/lib/index.js',
  'node_modules/@tencent-connect/dsh-qqbot/lib/gateway/bootstrap.js'
]
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const hashes = Object.fromEntries(input.flatMap(name => {
  const path = join(root, name)
  return name.includes('.') ? [path] : walk(path)
}).sort().map(path => [relative(root, path), sha(path)]))
const parts = ['@deepseek-ai/dsh','@tencent-connect/dsh-qqbot','@tencent-connect/qqbot-nodejs','dsh-email','imapflow','mailparser','nodemailer']
const versions = Object.fromEntries(parts.map(name => [name, lock.packages['node_modules/' + name]?.version]))
const release = { name: manifest.name, version: manifest.version, node: process.version, schemaVersion: 4, versions, sha256: hashes }
if (process.argv.includes('--verify')) {
  if (JSON.stringify(release) !== JSON.stringify(readJSON(file))) throw Error('发布文件或运行时版本校验失败')
  console.log('发布清单校验通过')
} else {
  mkdirSync(dist, { recursive: true })
  writeFileSync(file, JSON.stringify(release, null, 2) + '\n')
}
