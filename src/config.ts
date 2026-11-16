import { resolve } from 'node:path'
import { homedir } from 'node:os'

const env = process.env
const word = (key: string) => env[key]?.trim() ?? ''
const flag = (key: string) => word(key) === '1'
const check = (valid: boolean, message: string) => { if (!valid) throw Error(message) }

export function readConfig() {
  const stateDir = resolve(word('DSH_MAIL_STATE') || resolve(homedir(), '.local/state/dsh-mail-assistant'))
  const config = {
    stateDir, live: flag('MAIL_LIVE'), user: word('MAIL_USER'), auth: word('MAIL_AUTH_CODE'),
    owner: word('QQ_OWNER_OPENID'), appId: word('QQBOT_APPID'), appSecret: word('QQBOT_SECRET'),
    enroll: word('QQ_ENROLL_CODE'), healthPort: Number(word('DSH_MAIL_HEALTH_PORT') || 3081),
    sentFolder: word('MAIL_SENT_FOLDER') || undefined,
    modelProvider: word('DSH_MAIL_MODEL_PROVIDER'), modelName: word('DSH_MAIL_MODEL_NAME'),
    modelCallsDaily: Number(word('DSH_MAIL_MODEL_CALLS_DAILY') || 1000)
  }
  check(!config.user || /^[^\s<>@]+@163\.com$/i.test(config.user), 'MAIL_USER 需要完整的 163 邮箱地址')
  check(Boolean(config.owner) === /^[A-Za-z0-9_-]+$/.test(config.owner), 'QQ_OWNER_OPENID 格式无效')
  check(!config.enroll || /^[a-fA-F0-9]{32,64}$/.test(config.enroll), 'QQ_ENROLL_CODE 需要 32～64 位随机十六进制字符')
  check(!config.enroll || Boolean(config.appId && config.appSecret && !config.live && !config.owner),
    '绑定 QQ 前需要 AppID 和 Secret，且 MAIL_LIVE=0、QQ_OWNER_OPENID 为空')
  check(!config.live || Boolean(config.user && config.auth && config.owner && config.appId && config.appSecret),
    '启用 MAIL_LIVE 前请填写 163 授权码、QQ 凭据及所有者 OpenID')
  check(Boolean(config.modelProvider) === Boolean(config.modelName), '请同时填写模型 provider 和 model')
  check(Number.isInteger(config.healthPort) && config.healthPort >= 1024 && config.healthPort <= 65535, '健康页端口无效')
  check(Number.isInteger(config.modelCallsDaily) && config.modelCallsDaily > 0, '模型每日调用上限无效')
  return config
}
