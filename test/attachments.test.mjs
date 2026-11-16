import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { extractAttachment } from '../lib/attachment-text.js'

function office(parts) {
  return execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.stdout.buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, content in json.load(sys.stdin).items():
        archive.writestr(name, content)
`], { input: JSON.stringify(parts) })
}

function pdf(objects) {
  const segments = [Buffer.from('%PDF-1.4\n')]
  let offset = segments[0].length
  const offsets = objects.map((object, index) => {
    const entry = `${String(offset).padStart(10, '0')} 00000 n \n`
    const additions = [Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]
    offset += additions.reduce((size, part) => size + part.length, 0)
    segments.push(...additions)
    return entry
  })
  const size = objects.length + 1
  segments.push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`))
  return Buffer.concat(segments)
}

function pdfStream(contents, attributes = '') {
  return Buffer.concat([Buffer.from(`<< /Length ${contents.length} ${attributes} >>\nstream\n`),
    Buffer.from(contents), Buffer.from('\nendstream')])
}

function searchablePdf() {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    pdfStream('BT /F1 18 Tf 50 100 Td (Attachment delivery Friday) Tj ET'),
  ])
}

test('reads UTF-16 and GB18030 spreadsheet text without losing Chinese', async () => {
  assert.deepEqual(await extractAttachment('交付.csv', 'application/octet-stream', Buffer.from('项目,交付\r\n', 'utf16le')), {
    status: 'read', text: '项目,交付',
  })
  assert.deepEqual(await extractAttachment('交付.txt', 'text/plain', Buffer.from('bdbbb8b6', 'hex'), 'gb18030'), {
    status: 'read', text: '交付',
  })
})

test('HTML attachments expose visible text without scripts, hidden text, or resource URLs', async () => {
  const result = await extractAttachment('invoice.html', 'text/html', Buffer.from(
    '<p>交付 <strong>周五</strong></p><script>ACTIVE</script><div hidden>HIDDEN</div>' +
    '<img src="https://invalid.test/pixel" alt="PIXEL"><a href="https://invalid.test">链接</a>'
  ))
  assert.equal(result.status, 'read')
  assert.match(result.text, /交付 周五/)
  assert.match(result.text, /链接/)
  assert.doesNotMatch(result.text, /ACTIVE|HIDDEN|PIXEL|invalid\.test/)
})

test('Office attachments preserve Word paragraphs, spreadsheet values and the declared slide order', { skip: !existsSync('/usr/bin/python3') }, async () => {
  const word = await extractAttachment('notice.docx', 'application/octet-stream', office({
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>交付</w:t></w:r><w:r><w:t>周五</w:t></w:r></w:p><w:p><w:r><w:t>请确认</w:t></w:r></w:p></w:body></w:document>',
  }))
  assert.deepEqual(word, { status: 'read', text: '交付周五\n请确认' })

  const excel = await extractAttachment('prices.xlsx', 'application/octet-stream', office({
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="货款" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><r><t>阶段</t></r><r><t>一</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>货款</t></is></c><c r="D1"><v>1475.25</v></c></row></sheetData></worksheet>',
  }))
  assert.equal(excel.status, 'read')
  assert.match(excel.text, /阶段一.*货款.*1475\.25/)

  const slides = await extractAttachment('proposal.pptx', 'application/octet-stream', office({
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:ppt" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId9"/><p:sldId r:id="rId3"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId3" Target="slides/slide3.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/><Relationship Id="rId9" Target="slides/slide9.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>',
    'ppt/slides/slide3.xml': '<p:sld xmlns:p="urn:ppt" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>结论</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide9.xml': '<p:sld xmlns:p="urn:ppt" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>开始</a:t></a:r></a:p></p:sld>',
  }))
  assert.equal(slides.status, 'read')
  assert.match(slides.text, /开始[\s\S]*结论/)
})

test('rejects Office DTD and discloses corrupt or unsupported attachments', { skip: !existsSync('/usr/bin/python3') }, async () => {
  const result = await extractAttachment('external.docx', 'application/octet-stream', office({
    'word/document.xml': '<!DOCTYPE document [<!ENTITY secret SYSTEM "file:///etc/passwd">]><document><p><t>&secret;</t></p></document>',
  }))
  assert.equal(result.status, 'failed')
  assert.ok(result.reason)
  assert.equal(result.text, undefined)
  assert.equal((await extractAttachment('broken.docx', 'application/octet-stream', Buffer.from('PK\x03\x04'))).status, 'failed')
  assert.equal((await extractAttachment('archive.zip', 'application/zip', Buffer.from('PK\x03\x04'))).status, 'unsupported')
  assert.deepEqual(await extractAttachment('empty.txt', 'text/plain', Buffer.from('   ')), { status: 'empty' })
})

test('reads a searchable PDF whose attachment filename contains shell characters', { skip: !existsSync('/usr/bin/pdftotext') }, async () => {
  const result = await extractAttachment('--$(does-not-run) report.pdf', 'application/pdf', searchablePdf())
  assert.equal(result.status, 'read')
  assert.equal(result.text, 'Attachment delivery Friday')
})

const fixtureFont = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const ocrTools = ['/usr/bin/tesseract', '/usr/bin/convert', '/usr/bin/pdftotext', '/usr/bin/pdftoppm', fixtureFont]
const ocrReady = ocrTools.every(existsSync)
  && /\bchi_sim\b/.test(execFileSync('/usr/bin/tesseract', ['--list-langs'], { encoding: 'utf8' }))

function image(label, format) {
  return execFileSync('/usr/bin/convert', [
    '-size', '900x240', 'xc:white', '-font', fixtureFont, '-pointsize', '52',
    '-fill', 'black', '-gravity', 'center', '-annotate', '0', label,
    '-colorspace', 'Gray', '-depth', '8', `${format}:-`,
  ])
}

test('recognizes a PNG attachment', { skip: !ocrReady }, async () => {
  const result = await extractAttachment('delivery.png', 'image/png', image('DELIVERY FRIDAY', 'png'))
  assert.equal(result.status, 'read', result.reason)
  assert.match(result.text, /DELIVERY FRIDAY/)
})

test('recognizes both pages in a fully scanned PDF', { skip: !ocrReady }, async () => {
  const scanObjects = ['DELIVERY FRIDAY', 'ACCOUNT MONDAY'].flatMap((title, index) => {
    const streamRef = 4 + index * 3
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 240] /Resources << /XObject << /Scan ${streamRef + 1} 0 R >> >> /Contents ${streamRef} 0 R >>`,
      pdfStream('q 900 0 0 240 0 0 cm /Scan Do Q'),
      pdfStream(deflateSync(image(title, 'gray')), '/Type /XObject /Subtype /Image /Width 900 /Height 240 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode'),
    ]
  })
  const scanned = pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    ...scanObjects,
  ])
  const result = await extractAttachment('two-page-scan.pdf', 'application/pdf', scanned)
  assert.equal(result.status, 'read', result.reason)
  assert.match(result.text, /DELIVERY FRIDAY[\s\S]*ACCOUNT MONDAY/)
})

const legacyFixtureTools = ['/usr/bin/libreoffice', '/usr/bin/catdoc']
test('reads a short Word 97 document even when antiword cannot parse its text stream', {
  skip: !legacyFixtureTools.every(existsSync),
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'attachment-legacy-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'notice.html')
  writeFileSync(input, '<html><body><p>Legacy document delivery Friday</p></body></html>')
  execFileSync('/usr/bin/libreoffice', [
    `-env:UserInstallation=${pathToFileURL(join(dir, 'profile'))}`,
    '--headless', '--convert-to', 'doc:MS Word 97', '--outdir', dir, input,
  ], { stdio: 'pipe', timeout: 20_000 })
  const result = await extractAttachment('notice.doc', 'application/msword', readFileSync(join(dir, 'notice.doc')))
  assert.equal(result.status, 'read', result.reason)
  assert.match(result.text, /Legacy document delivery Friday/)
})
