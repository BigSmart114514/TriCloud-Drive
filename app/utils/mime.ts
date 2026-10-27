// 扩展名 → MIME。
//
// ## 为什么从组件里搬出来
//
// 原先这段是 FilePreviewer.vue 里的一个局部函数，唯一的作用是给压缩包内的
// 条目补 Content-Type。现在 `<video>` / `<audio>` 也要用：COS 上的旧对象
// 可能没有正确的 Content-Type，下载回来的 Blob 就是 application/octet-stream，
// 部分浏览器会据此拒绝选解码器。
//
// 搬出来之后它是纯函数，测试可以直接 import 断言具体 MIME，而不是 grep
// 组件里有没有出现某个字符串。
import { extensionOf } from '~/utils/previewer'

export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',

  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',

  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  weba: 'audio/webm',

  pdf: 'application/pdf',
  zip: 'application/zip'
}

export function mimeFor(filename: string): string {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? 'application/octet-stream'
}

/**
 * 给缺类型（空串 / octet-stream）的 Blob 补上扩展名对应的 MIME。
 *
 * 已经带具体类型的**原样返回**：服务端说这是 audio/ogg，就不要因为文件名是
 * .mp3 把它硬改成 audio/mpeg —— 解码器要看的是真实内容。
 *
 * 认不出来的扩展名也返回原 Blob：编一个 application/octet-stream 并不会让
 * 浏览器更愿意播，反而多包一层。
 */
export function withMimeType(blob: Blob, filename: string): Blob {
  if (blob.type && blob.type !== 'application/octet-stream') return blob
  const type = mimeFor(filename)
  if (type === 'application/octet-stream') return blob
  return new Blob([blob], { type })
}
