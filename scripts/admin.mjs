import { mkdirSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { ImapSmtpMailbox, MailIssue } from '../lib/mail.js'
import { Store } from '../lib/store.js'
import { readConfig } from '../lib/config.js'
import { loadSecrets, local } from './local-env.mjs'

process.umask(0o077)
const [command, argument, second] = process.argv.slice(2)
if (!command) {
  console.log('命令：verify，status，backup <文件>，reconcile <带时区日期时间>，pause-scan，resume-scan，retry-copy <D编号> <版本>，retry-notice <通知键>')
  process.exit(0)
}
loadSecrets()
process.env.DSH_MAIL_STATE ||= join(local, 'state')
const config = readConfig()
const path = join(config.stateDir, 'mail.sqlite')
const needsMailbox = ['verify','reconcile'].includes(command)
if (needsMailbox && !config.mailReady) throw Error('请先配置邮箱地址、IMAP 与 SMTP 主机和认证信息')
const mailbox = new ImapSmtpMailbox(config)
try {
  if (command === 'verify') {
    try {
      const sent = await mailbox.verify()
      console.log(JSON.stringify({ imap: 'authenticated', smtp: 'authenticated', sentFolders: sent }))
    } catch (error) {
      console.error(error instanceof MailIssue ? error.code : 'SMTP 验证失败 ' + (Number(error?.responseCode) || '(未返回响应码)'))
      process.exitCode = 1
    }
  } else if (command === 'backup') {
    if (!argument) throw Error('请指定备份文件路径')
    const destination = resolve(argument)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      closeSync(openSync(destination, 'wx', 0o600))
      try {
        await backup(db, destination)
        const check = new DatabaseSync(destination, { readOnly: true })
        try {
          if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw Error('SQLite 备份完整性校验失败')
        } finally { check.close() }
      } catch (error) {
        if (existsSync(destination)) unlinkSync(destination)
        throw error
      }
    } finally { db.close() }
    console.log('一致性备份已保存到 ' + destination)
  } else {
    if (!existsSync(path)) throw Error('请先启动一次邮件助手来初始化 SQLite')
    const store = new Store(path)
    try {
      if (command === 'status') console.log(JSON.stringify(store.health(), null, 2))
      else if (command === 'reconcile') {
        if (!argument || !/(?:Z|[+-]\d{2}:\d{2})$/.test(argument)) throw Error('请输入带时区的 ISO 时间')
        if (config.user) store.bind(config.user, config.appId, config.owner)
        await mailbox.reconcile(store, Date.parse(argument))
        console.log('UID 核对与补扫已提交')
      } else if (command === 'pause-scan' || command === 'resume-scan') {
        store.setSetting('scan_paused', command === 'pause-scan' ? '1' : '0')
        console.log(command === 'pause-scan' ? '下次启动保持暂停扫描' : '下次启动恢复扫描')
      } else if (command === 'retry-copy') {
        if (!config.sentFolder) throw Error('请先设置 MAIL_SENT_FOLDER')
        const draft = /^D(\d+)$/i.exec(argument ?? '')
        const version = /^v?(\d+)$/i.exec(second ?? '')
        if (!draft || !version || !store.retryCopy(Number(draft[1]), Number(version[1]))) throw Error('没有可核对的已发送副本')
        console.log('副本已排队核对，不会重新提交 SMTP')
      } else if (command === 'retry-notice') {
        if (!argument || !store.retryNotice(argument)) throw Error('没有可重试的明确失败通知')
        console.log('QQ 通知已重新排队')
      } else throw Error('未知维护命令')
    } finally { store.close() }
  }
} finally { mailbox.close() }
