import { createHash, timingSafeEqual } from 'node:crypto'
import { domainToASCII } from 'node:url'
export function constantTimeEqual(a: string, b: string) {
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(a), digest(b))
}
export function nowShanghaiDay(now: number) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

export function canonicalAddress(value: string) {
  const at = value.lastIndexOf('@')
  if (at <= 0) return undefined
  const local = value.slice(0, at)
  if (local.length > 64 || !/^[a-z\d!#$%&'*+\-/=?^_\x60{|}~]+(?:\.[a-z\d!#$%&'*+\-/=?^_\x60{|}~]+)*$/i.test(local)) return undefined
  const inputDomain = value.slice(at + 1)
  if (/[\s\\/:@?#%]/.test(inputDomain)) return undefined
  const domain = domainToASCII(inputDomain).toLowerCase()
  if (domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return undefined
  return local + '@' + domain
}
