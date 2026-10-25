// 文本预览的编码：怎么解、怎么编、哪种编不回去。
//
// ## 为什么要有这一层
//
// 中文 .txt 有相当一部分不是 UTF-8：Windows 记事本存下来的老文件多是 GBK，
// 台湾/香港来的多是 Big5。它们按 UTF-8 解出来就是满屏「�」，而 Blob.text()
// 只会 UTF-8 —— 没有别的地方能改这个判定。
//
// ## 为什么反查表是运行时算出来的
//
// 平台在这里是不对称的：TextDecoder 能解全部 legacy 编码，TextEncoder 只能编
// UTF-8。为了十来种编码引一个 iconv 库不值得（体积、许可、还要为它写测试），
// 而反查表可以从 TextDecoder 本身推出来 —— 把每个合法字节序列单独解一次，
// 「字 → 字节」的映射就有了。GBK 两万四千条，建一次约 20ms，只在真要保存
// 非 UTF-8 时才建，且一个会话只建一次。
//
// 代价是只覆盖**双字节**区：GB18030 的四字节区（生僻字、emoji）没有反查项，
// 保存到那里会抛 UnencodableCharacterError。报错比静默替换成「?」好 ——
// 后者是悄悄把用户的文件改坏。
//
// ## BOM
//
// 解码时 TextDecoder 默认丢掉 BOM（UTF-8 / UTF-16 都是），所以界面上看不到它。
// 编码时 UTF-8 不加 BOM（现代约定，加了反而让某些工具把 BOM 当正文）；
// UTF-16 一律加 —— 没有字节序标记的 UTF-16 文件，记事本一类工具会认错或乱码。
// 也就是说：一个带 BOM 的 UTF-8 文件保存后会丢掉 BOM。这是刻意的取舍。

export type TextEncodingId =
  | 'utf-8'
  | 'gbk'
  | 'gb18030'
  | 'big5'
  | 'shift_jis'
  | 'utf-16le'
  | 'utf-16be'

export interface TextEncoding {
  id: TextEncodingId
  label: string
}

/**
 * 下拉里的顺序，也是默认值的来源（第一项）。
 *
 * UTF-8 放最前：它是默认，也是唯一一个不需要反查表、怎么写都不会失败的编码。
 */
export const TEXT_ENCODINGS: readonly TextEncoding[] = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'gbk', label: 'GBK' },
  { id: 'gb18030', label: 'GB18030' },
  { id: 'big5', label: 'Big5' },
  { id: 'shift_jis', label: 'Shift_JIS' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' }
] as const

export const DEFAULT_TEXT_ENCODING: TextEncodingId = 'utf-8'

const ENCODING_IDS: ReadonlySet<string> = new Set(TEXT_ENCODINGS.map((e) => e.id))

/** 挡住下拉里被改过的值、以及任何从别处传进来的字符串。 */
export function isTextEncodingId(value: unknown): value is TextEncodingId {
  return typeof value === 'string' && ENCODING_IDS.has(value)
}

/**
 * 选中的编码写不下这个字。
 *
 * 带上出问题的**那个字**：只说「保存失败」的话，用户在一篇长文里根本找不出
 * 是哪一处，只能整篇重打或换编码盲试。
 */
export class UnencodableCharacterError extends Error {
  readonly char: string
  readonly encoding: TextEncodingId

  constructor(char: string, encoding: TextEncodingId) {
    super(`当前编码写不了「${char}」，请改用 UTF-8`)
    this.name = 'UnencodableCharacterError'
    this.char = char
    this.encoding = encoding
  }
}

/**
 * 按指定编码解字节。
 *
 * 非致命模式：非法字节变成 U+FFFD 而不是抛异常 —— 用户选错编码是常态，
 * 应该看到「这段不对」然后换一个，而不是整个预览直接报错关掉。
 */
export function decodeText(bytes: Uint8Array, encoding: TextEncodingId): string {
  return new TextDecoder(encoding, { fatal: false }).decode(bytes)
}

/** 反查表按编码缓存：建表要遍历两万多个字节序列，不能每次保存都来一遍。 */
const encodeMaps = new Map<TextEncodingId, Map<number, number>>()

/** 一个字节序列只解出一个字符时才认，U+FFFD 说明这组字节在这个编码里非法。 */
function singleCodePoint(text: string): number | null {
  const chars = [...text]
  if (chars.length !== 1) return null
  const codePoint = chars[0]!.codePointAt(0)!
  return codePoint === 0xfffd ? null : codePoint
}

/**
 * 建「码点 → 字节」的反查表。
 *
 * 值的高位第 16 位表示长度：置位 = 双字节（低 16 位是 lead<<8|trail），
 * 否则就是单字节本身。单字节区必须也扫：Shift_JIS 的半角片假名在
 * 0xA1–0xDF，不在任何双字节序列里。
 */
function encodeMapFor(encoding: TextEncodingId): Map<number, number> {
  const cached = encodeMaps.get(encoding)
  if (cached) return cached

  const decoder = new TextDecoder(encoding)
  const map = new Map<number, number>()
  for (let byte = 0x80; byte <= 0xff; byte++) {
    const codePoint = singleCodePoint(decoder.decode(new Uint8Array([byte])))
    if (codePoint !== null) map.set(codePoint, byte)
  }
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue
      const codePoint = singleCodePoint(decoder.decode(new Uint8Array([lead, trail])))
      if (codePoint !== null) map.set(codePoint, 0x10000 | (lead << 8) | trail)
    }
  }

  encodeMaps.set(encoding, map)
  return map
}

/**
 * 把文本编成指定编码的字节。编不出来时抛 UnencodableCharacterError。
 *
 * ASCII 在所有这些编码里都是单字节直通，所以不必查表 —— 一张 Markdown 里
 * 绝大部分内容都是 ASCII。
 */
export function encodeText(text: string, encoding: TextEncodingId): Uint8Array {
  if (encoding === 'utf-8') return new TextEncoder().encode(text)

  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const littleEndian = encoding === 'utf-16le'
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes[0] = littleEndian ? 0xff : 0xfe
    bytes[1] = littleEndian ? 0xfe : 0xff
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      const at = 2 + i * 2
      bytes[at] = littleEndian ? code & 0xff : code >>> 8
      bytes[at + 1] = littleEndian ? code >>> 8 : code & 0xff
    }
    return bytes
  }

  const map = encodeMapFor(encoding)
  const out: number[] = []
  for (const char of text) {
    const codePoint = char.codePointAt(0)!
    if (codePoint < 0x80) {
      out.push(codePoint)
      continue
    }
    const packed = map.get(codePoint)
    if (packed === undefined) throw new UnencodableCharacterError(char, encoding)
    if (packed >= 0x10000) out.push((packed >>> 8) & 0xff, packed & 0xff)
    else out.push(packed)
  }
  return new Uint8Array(out)
}
