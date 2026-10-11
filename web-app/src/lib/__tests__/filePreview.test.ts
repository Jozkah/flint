import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import {
  csvPreview,
  docxPreview,
  pptxPreview,
  previewFromBytes,
  previewKind,
  textPreview,
  xlsxPreview,
} from '../filePreview'

function zip(files: Record<string, string>, store = false): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameB = Buffer.from(name)
    const raw = Buffer.from(text)
    const data = store ? raw : deflateRawSync(raw)
    const method = store ? 0 : 8
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameB.length, 26)
    parts.push(lh, nameB, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameB.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameB)
    offset += 30 + nameB.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, cd, end]))
}

describe('filePreview', () => {
  it('maps extensions to preview kinds', () => {
    expect(previewKind('CSV')).toBe('table')
    expect(previewKind('docx')).toBe('docx')
    expect(previewKind('png')).toBeNull()
    expect(previewKind('ts')).toBe('text')
  })

  it('takes the first 8 lines of text and clips long ones', () => {
    const p = textPreview(
      Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    )
    expect(p).toEqual({
      kind: 'text',
      lines: ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
    })
    const long = textPreview('x'.repeat(500))
    expect(long && long.kind === 'text' && long.lines[0].length).toBeLessThan(
      130
    )
    expect(textPreview('')).toBeNull()
  })

  it('parses csv with quotes and tsv, bounded', () => {
    const p = csvPreview('a,b,c\n"x,1","he said ""hi""",3\r\n1,2,3,4,5,6,7\n')
    expect(p).toEqual({
      kind: 'table',
      rows: [
        ['a', 'b', 'c'],
        ['x,1', 'he said "hi"', '3'],
        ['1', '2', '3', '4', '5'],
      ],
    })
    expect(csvPreview('a\tb\n1\t2', '\t')).toEqual({
      kind: 'table',
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    })
  })

  it('extracts docx paragraphs', async () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; world</w:t></w:r></w:p>' +
      '<w:p></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>'
    const p = await docxPreview(zip({ 'word/document.xml': xml }))
    expect(p).toEqual({ kind: 'doc', paragraphs: ['Hello & world', 'Second'] })
    expect(await docxPreview(zip({ 'other.xml': 'x' }))).toBeNull()
  })

  it('extracts the first xlsx rows from shared and inline strings', async () => {
    const sst = '<sst><si><t>Name</t></si><si><t>Qty</t></si></sst>'
    const sheet =
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>bolt</t></is></c><c r="B2"><v>42</v></c></row>' +
      '</sheetData></worksheet>'
    const p = await xlsxPreview(
      zip({ 'xl/sharedStrings.xml': sst, 'xl/worksheets/sheet1.xml': sheet })
    )
    expect(p).toEqual({
      kind: 'table',
      rows: [
        ['Name', 'Qty'],
        ['bolt', '42'],
      ],
    })
  })

  it('extracts pptx first slide text, also from stored entries', async () => {
    const xml =
      '<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Point</a:t></a:r></a:p></p:sld>'
    const p = await pptxPreview(zip({ 'ppt/slides/slide1.xml': xml }, true))
    expect(p).toEqual({ kind: 'doc', paragraphs: ['Title', 'Point'] })
  })

  it('degrades to null on garbage', async () => {
    expect(await previewFromBytes('docx', new Uint8Array([1, 2, 3]))).toBeNull()
    expect(await previewFromBytes('png', new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
