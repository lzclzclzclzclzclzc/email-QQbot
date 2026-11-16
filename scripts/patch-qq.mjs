import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const req = createRequire(import.meta.url)
const root = dirname(req.resolve('@tencent-connect/dsh-qqbot/package.json'))
const expected = {
  'lib/index.js': 'dc03a2712e87b10d7a83662b26284652fd59d7784ca2a10a21eb680d61aafa13',
  'lib/gateway/bootstrap.js': '66dea47f05474ea8965a7ec9e0b60aeaead92bf416ec1493ccb4fe6940221a5c'
}
const marker = '// DSH_MAIL_ASSISTANT_0_1'
const sha = data => createHash('sha256').update(data).digest('hex')
const edits = {
  'lib/index.js': [
    ["export const inject = ['agents'];", marker + "\nexport const inject = process.env.DSH_MAIL_MANAGED === '1' ? ['agents', 'mailAssistantBridge'] : ['agents'];"],
    ['    let appId =', "    if (process.env.DSH_MAIL_MANAGED === '1' && (!process.env.QQBOT_APPID || !process.env.QQBOT_SECRET)) return;\n    let appId ="],
    ["    let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');",
      "    let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');\n    if (process.env.DSH_MAIL_MANAGED === '1') {\n        appId = process.env.QQBOT_APPID;\n        appSecret = process.env.QQBOT_SECRET;\n    }"]
  ],
  'lib/gateway/bootstrap.js': [
    ['        logger,\n    });', marker + "\n        logger: process.env.DSH_MAIL_MANAGED === '1' ? { info() {}, warn() {}, error() {} } : logger,\n    });"],
    ['    logger.info(`QQBot SDK initialized', "    if (process.env.DSH_MAIL_MANAGED === '1') {\n        const bridge = ctx.get('mailAssistantBridge');\n        if (!bridge) throw Error('Mail assistant bridge is missing');\n        return bridge.attach(ctx, bot, config.appId);\n    }\n    logger.info(`QQBot SDK initialized"]
  ]
}
for (const [file, actions] of Object.entries(edits)) {
  const path = join(root, file)
  const actual = readFileSync(path, 'utf8')
  const pristine = actions.toReversed().reduce((text, [from, to]) => text.replace(to, from), actual)
  if (sha(pristine) !== expected[file]) throw Error('QQ 0.5.5 文件校验失败 ' + file)
  const patch = actions.reduce((text, [from, to]) => {
    if (text.split(from).length !== 2) throw Error('QQ 补丁锚点异常 ' + file)
    return text.replace(from, to)
  }, pristine)
  if (actual !== patch) writeFileSync(path, patch, { mode: 0o644 })
}
