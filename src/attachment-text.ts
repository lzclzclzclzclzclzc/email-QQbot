import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser } from 'htmlparser2'

export interface AttachmentExtraction {
  status: 'read' | 'empty' | 'unsupported' | 'failed' | 'partial'
  text?: string
  reason?: string
}

const mib = 1024 * 1024
const maxInput = 20 * mib
const maxParserOutput = 32 * mib
const maxScanPages = 20
const scanTimeout = 45_000
const officeScript = fileURLToPath(new URL('../scripts/extract-office.py', import.meta.url))

const extensions = new Map(Object.entries({
  docx: 'word', docm: 'word', dotx: 'word', dotm: 'word',
  xlsx: 'excel', xlsm: 'excel', xltx: 'excel', xltm: 'excel',
  pptx: 'powerpoint', pptm: 'powerpoint', ppsx: 'powerpoint', ppsm: 'powerpoint',
  odt: 'odf', ods: 'odf', odp: 'odf',
  doc: 'doc', xls: 'xls', ppt: 'ppt', pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', tif: 'image', tiff: 'image',
  bmp: 'image', webp: 'image', gif: 'image',
  html: 'html', htm: 'html', xhtml: 'html',
  txt: 'text', csv: 'text', tsv: 'text', md: 'text', json: 'text', xml: 'text', log: 'text',
  ics: 'text', vcf: 'text', yaml: 'text', yml: 'text',
}))
const mimeFormats = new Map(Object.entries({
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'powerpoint',
  'application/vnd.ms-word.document.macroenabled.12': 'word',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'excel',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'powerpoint',
  'application/vnd.oasis.opendocument.text': 'odf',
  'application/vnd.oasis.opendocument.spreadsheet': 'odf',
  'application/vnd.oasis.opendocument.presentation': 'odf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/pdf': 'pdf',
  'text/html': 'html', 'application/xhtml+xml': 'html',
  'application/json': 'text', 'application/xml': 'text', 'application/csv': 'text',
  'image/png': 'image', 'image/jpeg': 'image', 'image/tiff': 'image', 'image/bmp': 'image',
  'image/webp': 'image', 'image/gif': 'image',
}))

class ParserFailure extends Error {
  constructor(message: string, readonly tryAlternateParser = false) { super(message) }
}

async function runTool(tool: string, args: string[], cwd: string, input?: Buffer, timeout = 12_000) {
  const command = `/usr/bin/${tool}`
  const limiter = '/usr/bin/prlimit'
  try { await access(command, constants.X_OK) }
  catch { throw new ParserFailure(`缺少附件解析工具 ${tool}`, true) }
  try { await access(limiter, constants.X_OK) }
  catch { throw new ParserFailure('缺少附件解析所需的资源限制工具 prlimit') }
  return new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = execFile(limiter, [
      '--as=536870912', '--cpu=12', '--fsize=33554432', '--nofile=128', '--core=0', '--', command, ...args,
    ], {
      cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, LANG: 'C.UTF-8', OMP_THREAD_LIMIT: '1' },
      encoding: 'buffer', timeout, killSignal: 'SIGKILL', maxBuffer: maxParserOutput,
    }, (error, stdout, stderr) => {
      if (!error) resolve({ stdout, stderr })
      else if (error.killed || error.signal || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        reject(new ParserFailure('附件解析超出时间、内存或输出大小限制'))
      else if (/incorrect password|encrypted|encryption/i.test(stderr.toString('utf8')))
        reject(new ParserFailure('附件已加密或受密码保护'))
      else reject(new ParserFailure('附件损坏、使用了不支持的编码或无法解析', true))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

function normalize(text: string) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '').trim()
}

function extracted(value: string, reason?: string): AttachmentExtraction {
  const text = normalize(value)
  if (reason) return text ? { status: 'partial', text, reason } : { status: 'failed', reason }
  if (text.length) return { status: 'read', text }
  return { status: 'empty' }
}

function decode(content: Buffer, charset?: string) {
  const prefix = content.subarray(0, 3).toString('hex')
  if (prefix.startsWith('fffe')) return new TextDecoder('utf-16le', { fatal: true }).decode(content)
  if (prefix.startsWith('feff')) return new TextDecoder('utf-16be', { fatal: true }).decode(content)
  if (prefix === 'efbbbf') return new TextDecoder('utf-8', { fatal: true }).decode(content)
  const encodings = charset ? [charset.replace(/^["']|["']$/g, '').trim(), 'utf-8'] : ['utf-8']
  if (content.length % 2 === 0) {
    const sampleLength = Math.min(content.length, 4096)
    let evenZero = 0
    let oddZero = 0
    for (let index = 0; index < sampleLength; index += 2) {
      if (content[index] === 0) evenZero++
      if (content[index + 1] === 0) oddZero++
    }
    if (oddZero > Math.max(1, sampleLength / 16, evenZero * 3)) encodings.unshift('utf-16le')
    if (evenZero > Math.max(1, sampleLength / 16, oddZero * 3)) encodings.unshift('utf-16be')
  }
  for (const encoding of [...new Set([...encodings, 'gb18030'])]) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(content)
      if (!/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return text
    } catch { /* Try the next encoding. */ }
  }
  throw new ParserFailure('附件为二进制数据或使用了无法识别的文本编码')
}

const hiddenTags = new Set(['head', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg',
  'img', 'video', 'audio', 'input', 'canvas'])
const htmlBlocks = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'div', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'footer', 'header', 'hr', 'li', 'p', 'pre', 'section', 'table', 'tr'])

function htmlText(text: string) {
  const parts: string[] = []
  const stack: Array<{ hidden: boolean; pre: boolean }> = []
  let atBreak = true
  const emit = (part: string) => {
    if ((part === '\n' || part === '\t') && atBreak) return
    parts.push(part)
    atBreak = part === '\n' || part === '\t'
  }
  const parser = new Parser({
    onopentag(name, attributes) {
      const parent = stack.at(-1)
      const hidden = Boolean(parent?.hidden || hiddenTags.has(name) || 'hidden' in attributes ||
        attributes['aria-hidden']?.toLowerCase() === 'true' ||
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attributes.style ?? ''))
      if (stack.length >= 512) throw new ParserFailure('HTML 附件结构层级超出解析限制')
      stack.push({ hidden, pre: Boolean(parent?.pre || name === 'pre') })
      if (!hidden && htmlBlocks.has(name)) emit('\n')
    },
    onclosetag(name) {
      const node = stack.pop()
      if (!node || node.hidden) return
      if (htmlBlocks.has(name)) emit('\n')
      if (name === 'td' || name === 'th') emit('\t')
    },
    ontext(value) {
      const node = stack.at(-1)
      if (!node?.hidden) emit(node?.pre ? value : value.replace(/\s+/g, ' '))
    },
  })
  parser.end(text)
  return parts.join('').replace(/[ \t]+\n[ \t]*/g, '\n')
}

function inferredCharset(mime: string, value: Buffer, format: string) {
  const declared = /(?:^|;)\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(mime)?.[1]
  if (declared || format !== 'html') return declared
  const header = value.subarray(0, 8192).toString('ascii')
  return /<meta\b[^>]*\bcharset\s*=\s*["']?([^"'\s;>]+)/i.exec(header)?.[1]
}

function pictureFormat(content: Buffer) {
  const prefix = content.subarray(0, 8).toString('hex')
  const known = ['89504e470d0a1a0a', 'ffd8ff', '49492a00', '4d4d002a', '474946383761', '474946383961']
  return known.some(header => prefix.startsWith(header)) ||
    (content.length >= 26 && prefix.startsWith('424d') && content.readUInt32LE(10) >= 26 &&
      content.readUInt32LE(10) < content.length && content.readUInt32LE(2) <= content.length) ||
    (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP')
}

async function ocrOptions(cwd: string) {
  const { stdout } = await runTool('tesseract', ['--list-langs'], cwd)
  const installed = stdout.toString('utf8').split(/\s+/)
  const wanted = ['eng', 'chi_sim']
  const available = wanted.filter(language => installed.includes(language))
  if (!available.length) throw new ParserFailure('缺少 Tesseract 中英文 OCR 语言数据')
  return { languages: available.join('+'), reason: available.length < wanted.length ? 'OCR 缺少中文或英文语言数据' : undefined }
}

async function recognize(image: Buffer, cwd: string, languages: string, timeout?: number) {
  const result = await runTool('tesseract', ['stdin', 'stdout', '-l', languages], cwd, image, timeout)
  return normalize(result.stdout.toString('utf8'))
}

async function pdfText(content: Buffer, cwd: string) {
  const path = join(cwd, 'input.pdf')
  await writeFile(path, content, { mode: 0o600 })
  const { stdout, stderr } = await runTool('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], cwd)
  const pages = stdout.toString('utf8').split('\f')
  if (pages.length > 1 && !pages.at(-1)?.trim()) pages.pop()
  const warnings = new Set<string>()
  if (/Syntax Error/i.test(stderr.toString('utf8'))) warnings.add('PDF 含有结构错误，部分内容可能未读到')
  const scanPages = pages.flatMap((page, index) => normalize(page) ? [] : [index])
  if (scanPages.length) {
    try {
      const options = await ocrOptions(cwd)
      const deadline = Date.now() + scanTimeout
      if (options.reason) warnings.add(options.reason)
      if (scanPages.length > maxScanPages) warnings.add(`扫描版 PDF 超过每份附件 ${maxScanPages} 页的 OCR 限制`)
      for (const index of scanPages.slice(0, maxScanPages)) {
        const left = deadline - Date.now()
        if (left <= 0) { warnings.add('扫描版 PDF 超出 OCR 时间限制'); break }
        try {
          const page = String(index + 1)
          const image = await runTool('pdftoppm', [
            '-f', page, '-l', page, '-singlefile', '-scale-to', '2200', '-gray', '-png', path,
          ], cwd, undefined, Math.min(12_000, left))
          pages[index] = await recognize(image.stdout, cwd, options.languages, Math.max(1, Math.min(12_000, deadline - Date.now())))
        } catch (error) {
          warnings.add(error instanceof ParserFailure ? error.message : '扫描版 PDF 有页面无法识别')
        }
      }
    } catch (error) {
      warnings.add(error instanceof ParserFailure ? error.message : '扫描版 PDF 无法识别')
    }
  }
  const result = extracted(pages.join('\n\n'), [...warnings].join('；') || undefined)
  return result.status === 'empty' ? { ...result, reason: 'PDF 未识别到可读文字' } : result
}

const legacyTools: Record<string, { tool: string; args: string[] }> = {
  doc: { tool: 'antiword', args: ['-m', 'UTF-8.txt'] },
  xls: { tool: 'xls2csv', args: ['-d', 'utf-8'] },
  ppt: { tool: 'catppt', args: ['-d', 'utf-8'] },
}

async function fileText(format: string, content: Buffer, cwd: string): Promise<AttachmentExtraction> {
  if (format === 'pdf') return pdfText(content, cwd)
  if (format === 'image') {
    if (!pictureFormat(content)) throw new ParserFailure('图片文件头无法识别')
    const { languages, reason } = await ocrOptions(cwd)
    const result = extracted(await recognize(content, cwd, languages), reason)
    return result.status === 'empty' ? { ...result, reason: '图片未识别到可读文字' } : result
  }
  const compound = content.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'
  const legacy = legacyTools[format]
  if (legacy) {
    if (!compound) throw new ParserFailure('旧版 Office 文件头无法识别')
    const path = join(cwd, `input.${format}`)
    await writeFile(path, content, { mode: 0o600 })
    const { stdout } = await runTool(legacy.tool, [...legacy.args, path], cwd).catch(error => {
      if (format !== 'doc' || !(error instanceof ParserFailure && error.tryAlternateParser)) throw error
      // Antiword rejects some small but valid Word 97 text streams.
      return runTool('catdoc', ['-d', 'utf-8', path], cwd)
    })
    return extracted(decode(stdout, 'utf-8'))
  }
  if (compound) throw new ParserFailure('Office 附件可能已加密或使用了旧版格式')
  const { stdout } = await runTool('python3', ['-I', '-B', officeScript, format], cwd, content)
  const result = JSON.parse(stdout.toString('utf8')) as { text?: string; reason?: string; error?: string }
  if (result.error) throw new ParserFailure(result.error)
  return extracted(result.text ?? '', result.reason)
}

export async function extractAttachment(filename: string, contentType: string, content: Buffer,
  charset?: string): Promise<AttachmentExtraction> {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  const extension = extname(filename).slice(1).toLowerCase()
  const fromName = extensions.get(extension)
  const fromMime = mimeFormats.get(mime)
  let format = fromName ?? fromMime ?? (mime.startsWith('text/') ? 'text' : undefined)
  if (!format && content.toString('ascii', 0, 5) === '%PDF-') format = 'pdf'
  if (!format && pictureFormat(content)) format = 'image'
  if (!format) return { status: 'unsupported', reason: '暂不支持此附件格式' }
  if (!content.length) return { status: 'empty' }
  if (content.length > maxInput) return { status: 'failed', reason: '附件超过 20 MiB 的解析大小限制' }

  try {
    if (format === 'text' || format === 'html') {
      const text = decode(content, charset ?? inferredCharset(contentType, content, format))
      return extracted(format === 'html' ? htmlText(text) : text)
    }
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-mail-attachment-'))
    try { return await fileText(format, content, cwd) }
    finally { await rm(cwd, { recursive: true, force: true }) }
  } catch (error) {
    return { status: 'failed', reason: error instanceof ParserFailure ? error.message : '附件无法解析' }
  }
}
