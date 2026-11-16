"""Read text from an Office ZIP container without extracting files or opening links."""
import io
import json
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


MIB = 1024 * 1024
MAX_INPUT = 20 * MIB
MAX_XML = 16 * MIB
MAX_XML_TOTAL = 64 * MIB
MAX_TEXT = 16 * MIB
OUTPUT_LIMIT = 'Office 附件的文字超出解析输出大小限制'


class DocumentIssue(Exception):
    pass


class BoundedTree(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nodes = 0

    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > 256 or self.nodes > 500_000:
            raise DocumentIssue('Office 附件的 XML 结构超出解析限制')
        return super().start(tag, attrs)

    def end(self, tag):
        self.depth -= 1
        return super().end(tag)

    def doctype(self, *_):
        raise DocumentIssue('Office 附件含有不允许的 XML 文档类型或实体')


class Package:
    def __init__(self, archive):
        entries = archive.infolist()
        if len(entries) > 8192 or sum(entry.file_size for entry in entries) > 256 * MIB:
            raise DocumentIssue('Office 附件解包后超出大小或文件数量限制')
        self.entries = {entry.filename: entry for entry in entries}
        if len(self.entries) != len(entries):
            raise DocumentIssue('Office 附件包含重复的内部文件')
        if any(entry.flag_bits & 1 for entry in entries):
            raise DocumentIssue('Office 附件已加密或受密码保护')
        self.archive = archive
        self.xml_bytes = 0

    def xml(self, name, required=True):
        entry = self.entries.get(name)
        if entry is None:
            if not required:
                return None
            raise DocumentIssue('Office 附件缺少必要的内部文件')
        remaining = min(MAX_XML, MAX_XML_TOTAL - self.xml_bytes)
        if entry.file_size > remaining:
            raise DocumentIssue('Office 附件的 XML 内容超出解析大小限制')
        with self.archive.open(entry) as source:
            data = source.read(remaining + 1)
        self.xml_bytes += len(data)
        if len(data) > remaining:
            raise DocumentIssue('Office 附件的 XML 内容超出解析大小限制')
        return ET.fromstring(data, parser=ET.XMLParser(target=BoundedTree()))

    def relationships(self, part):
        folder, name = posixpath.split(part)
        root = self.xml(posixpath.join(folder, '_rels', name + '.rels'), required=False)
        relationships = {}
        for item in children(root, 'Relationship'):
            target = item.get('Target', '')
            if not target or item.get('TargetMode', '').lower() == 'external' or '\\' in target:
                continue
            path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(folder, target))
            if not path.startswith(part.split('/')[0] + '/'):
                continue
            relationships[item.get('Id')] = (item.get('Type', '').rsplit('/', 1)[-1], path)
        return relationships


class Content:
    def __init__(self):
        self.lines = []
        self.size = 0
        self.warnings = set()

    def add(self, line):
        if not line.strip():
            return
        size = len(line.encode()) + 1
        if self.size + size > MAX_TEXT:
            self.warnings.add(OUTPUT_LIMIT)
            return
        self.size += size
        self.lines.append(line)

    def result(self):
        return {'text': '\n'.join(self.lines), 'reason': '；'.join(sorted(self.warnings)) or None}


def local(name):
    return name.rsplit('}', 1)[-1]


def children(node, name):
    return (child for child in node if local(child.tag) == name) if node is not None else ()


def child(node, name):
    return next(iter(children(node, name)), None)


def attribute(node, name):
    return next((value for key, value in node.attrib.items() if local(key) == name), None)


def relationship_id(node):
    return next((value for key, value in node.attrib.items()
                 if key.endswith('/relationships}id')), None)


def paragraph(node, depth_root=True):
    tag = local(node.tag)
    if tag == 'p' and not depth_root or tag in {'del', 'moveFrom'}:
        return ''
    if tag == 't':
        return node.text or ''
    if tag in {'tab', 'ptab'}:
        return '\t'
    if tag in {'br', 'cr'}:
        return '\n'
    return ''.join(paragraph(item, False) for item in node)


def word(package, content):
    names = ['word/document.xml', *sorted(
        name for name in package.entries if re.fullmatch(r'word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml', name)
    )]
    for name in names:
        root = package.xml(name)
        for node in root.iter():
            if local(node.tag) == 'p':
                content.add(paragraph(node))


def rich_string(node):
    if node is None:
        return ''
    return ''.join(item.text or '' for item in children(node, 't')) + ''.join(
        item.text or '' for run in children(node, 'r') for item in children(run, 't')
    )


def related_part(relationships, node, kind):
    relation_kind, path = relationships.get(relationship_id(node), (None, None))
    if relation_kind != kind or path is None:
        raise DocumentIssue('Office 附件缺少必要的内部页面或工作表')
    return path


def excel(package, content):
    workbook = 'xl/workbook.xml'
    root = package.xml(workbook)
    relations = package.relationships(workbook)
    strings = [rich_string(item) for item in children(package.xml('xl/sharedStrings.xml', required=False), 'si')]
    for sheet in children(child(root, 'sheets'), 'sheet'):
        sheet_root = package.xml(related_part(relations, sheet, 'worksheet'))
        content.add('工作表：' + sheet.get('name', ''))
        for row in children(child(sheet_root, 'sheetData'), 'row'):
            values = []
            row_size = 0
            for cell in children(row, 'c'):
                data_type = cell.get('t')
                value = child(cell, 'v')
                formula = child(cell, 'f')
                display = value.text or '' if value is not None else ''
                if data_type == 's' and display:
                    if not display.isascii() or not display.isdecimal() or len(display) > 8:
                        raise DocumentIssue('Excel 附件包含损坏的共享文本索引')
                    index = int(display)
                    if index >= len(strings):
                        raise DocumentIssue('Excel 附件包含损坏的共享文本索引')
                    display = strings[index]
                elif data_type == 'inlineStr':
                    display = rich_string(child(cell, 'is'))
                elif data_type == 'b':
                    display = {'0': 'FALSE', '1': 'TRUE'}.get(display, display)
                if not display and formula is not None:
                    content.warnings.add('Excel 有公式缺少已保存的计算结果')
                    if formula.text:
                        display = '=' + formula.text
                if display:
                    ref = cell.get('r', '')
                    entry = (ref + ' ' if ref else '') + display
                    row_size += len(entry.encode()) + 1
                    if content.size + row_size > MAX_TEXT:
                        content.add('\t'.join(values))
                        content.warnings.add(OUTPUT_LIMIT)
                        return
                    values.append(entry)
            if values:
                content.add('\t'.join(values))


def powerpoint(package, content):
    presentation = 'ppt/presentation.xml'
    root = package.xml(presentation)
    relations = package.relationships(presentation)
    for index, slide in enumerate(children(child(root, 'sldIdLst'), 'sldId'), 1):
        path = related_part(relations, slide, 'slide')
        lines = [paragraph(node) for node in package.xml(path).iter() if local(node.tag) == 'p']
        for kind, notes in package.relationships(path).values():
            if kind == 'notesSlide':
                lines.extend(paragraph(node) for node in package.xml(notes).iter() if local(node.tag) == 'p')
        if any(line.strip() for line in lines):
            content.add(f'第 {index} 张幻灯片')
            for line in lines:
                content.add(line)


def odf_paragraph(node):
    parts = [node.text or '']
    for item in node:
        tag = local(item.tag)
        if tag == 'tab':
            parts.append('\t')
        elif tag == 'line-break':
            parts.append('\n')
        elif tag == 's':
            # Repeated spaces are stored as a count; one separator is sufficient for plain text.
            parts.append(' ')
        else:
            parts.append(odf_paragraph(item))
        parts.append(item.tail or '')
    return ''.join(parts)


def odf(package, content):
    manifest = package.xml('META-INF/manifest.xml', required=False)
    if manifest is not None and any(local(node.tag) == 'encryption-data' for node in manifest.iter()):
        raise DocumentIssue('Office 附件已加密或受密码保护')
    root = package.xml('content.xml')
    body = child(root, 'body')
    spreadsheet = child(body, 'spreadsheet')
    if spreadsheet is not None:
        for table in children(spreadsheet, 'table'):
            content.add('工作表：' + (attribute(table, 'name') or ''))
            for row in (item for item in table.iter() if local(item.tag) == 'table-row'):
                row_cells = ['\n'.join(odf_paragraph(node) for node in children(cell, 'p'))
                             or attribute(cell, 'date-value') or attribute(cell, 'value') or ''
                             for cell in children(row, 'table-cell')]
                content.add('\t'.join(row_cells))
    elif body is not None:
        for node in body.iter():
            if local(node.tag) in {'p', 'h'}:
                content.add(odf_paragraph(node))


def extract(data, format_name):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        package = Package(archive)
        content = Content()
        {'word': word, 'excel': excel, 'powerpoint': powerpoint, 'odf': odf}[format_name](package, content)
        if any(re.match(r'(?:word|xl|ppt)/(?:media|embeddings)/|Pictures/', name)
               and not name.endswith('/') for name in package.entries):
            content.warnings.add('Office 中的嵌入图片或对象未识别')
        if any(re.match(r'(?:word|xl|ppt)/charts/[^/]+\.xml$', name) for name in package.entries):
            content.warnings.add('Office 中的图表未单独解析')
        return content.result()


def main():
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise DocumentIssue('Office 附件超出解析大小限制')
        result = extract(data, sys.argv[1])
    except DocumentIssue as error:
        result = {'error': str(error)}
    except (OSError, RuntimeError, ValueError, ET.ParseError, zipfile.BadZipFile):
        result = {'error': 'Office 附件损坏或使用了无法识别的格式'}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode())


if __name__ == '__main__':
    main()
