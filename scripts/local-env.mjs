import { chmodSync, copyFileSync, mkdirSync, statSync, constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const local = join(root, '.local')

export function loadSecrets() {
  const specified = process.env.DSH_MAIL_ENV_FILE
  const path = specified ? resolve(specified) : join(local, 'secrets.env')
  try {
    const stat = statSync(path)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw Error('凭据文件权限必须为 600 或更严格')
    process.loadEnvFile(path)
  } catch (error) {
    if (error.code !== 'ENOENT' || specified) throw error
  }
}

export function setupLocal() {
  const path = join(local, 'secrets.env')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { copyFileSync(join(root, 'deploy', 'secrets.env.example'), path, constants.COPYFILE_EXCL) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  chmodSync(path, 0o600)
  console.log(path)
}
