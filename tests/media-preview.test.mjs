// 视频 / 音频预览。
//
// ## 为什么单独一个文件
//
// 预览器注册表与默认映射在 previewer-choice.test.mjs；这里管两件媒体特有的事：
//
// 1. 扩展名 → MIME。`<video>` / `<audio>` 拿到 `application/octet-stream` 时
//    有些浏览器会拒绝选解码器，而 COS 上的旧对象不一定有正确的 Content-Type。
//    这一段是纯函数，直接跑。
// 2. 模板里到底有没有 controls、有没有偷偷 autoplay、src 接的是不是缓存
//    生成的那个 blob URL。没有挂载环境，只能对 SFC 做结构断言。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'
import { parse } from '@vue/compiler-sfc'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } = await import('../app/utils/previewer.ts')
const { MIME_BY_EXTENSION, mimeFor, withMimeType } = await import('../app/utils/mime.ts')

describe('媒体扩展名与 MIME', () => {
  test('每个视频扩展名都有 video/* 的 MIME', () => {
    assert.deepEqual([...VIDEO_EXTENSIONS].sort(), ['m4v', 'mkv', 'mov', 'mp4', 'ogv', 'webm'])
    for (const ext of VIDEO_EXTENSIONS) {
      assert.match(mimeFor(`a.${ext}`), /^video\//, ext)
    }
  })

  test('每个音频扩展名都有 audio/* 的 MIME', () => {
    assert.deepEqual([...AUDIO_EXTENSIONS].sort(), ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba'])
    for (const ext of AUDIO_EXTENSIONS) {
      assert.match(mimeFor(`a.${ext}`), /^audio\//, ext)
    }
  })

  test('常见容器逐项固定，不用猜', () => {
    const cases = {
      'a.mp4': 'video/mp4',
      'a.m4v': 'video/mp4',
      'a.webm': 'video/webm',
      'a.ogv': 'video/ogg',
      'a.mov': 'video/quicktime',
      'a.mkv': 'video/x-matroska',
      'a.mp3': 'audio/mpeg',
      'a.wav': 'audio/wav',
      'a.ogg': 'audio/ogg',
      'a.m4a': 'audio/mp4',
      'a.flac': 'audio/flac',
      'a.aac': 'audio/aac',
      'a.opus': 'audio/ogg',
      'a.weba': 'audio/webm'
    }
    for (const [name, mime] of Object.entries(cases)) assert.equal(mimeFor(name), mime, name)
  })

  test('原来的图片 / PDF / ZIP 映射没被搬丢', () => {
    assert.equal(mimeFor('a.PNG'), 'image/png')
    assert.equal(mimeFor('a.jpg'), 'image/jpeg')
    assert.equal(mimeFor('a.svg'), 'image/svg+xml')
    assert.equal(mimeFor('a.pdf'), 'application/pdf')
    assert.equal(mimeFor('a.zip'), 'application/zip')
    assert.equal(mimeFor('a.bin'), 'application/octet-stream')
    assert.equal(mimeFor('noext'), 'application/octet-stream')
  })

  test('媒体扩展名必须真的在 MIME 表里，不能只靠默认值', () => {
    for (const ext of [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]) {
      assert.ok(MIME_BY_EXTENSION[ext], `${ext} 没有 MIME 映射`)
      assert.notEqual(MIME_BY_EXTENSION[ext], 'application/octet-stream', `${ext} 落到 octet-stream`)
    }
  })

  test('withMimeType 给空类型 / octet-stream 补上扩展名对应的类型', () => {
    const empty = new Blob(['x'])
    const generic = new Blob(['x'], { type: 'application/octet-stream' })
    assert.equal(withMimeType(empty, 'a.mp4').type, 'video/mp4')
    assert.equal(withMimeType(generic, 'a.mp3').type, 'audio/mpeg')
  })

  test('已经带了具体类型就不动它（别把 webm 硬改成 mp4）', () => {
    const typed = new Blob(['x'], { type: 'audio/ogg' })
    assert.equal(withMimeType(typed, 'a.mp3'), typed)
  })

  test('认不出来的扩展名保持原样，不编一个类型', () => {
    const empty = new Blob(['x'])
    assert.equal(withMimeType(empty, 'a.bin'), empty)
    const generic = new Blob(['x'], { type: 'application/octet-stream' })
    assert.equal(withMimeType(generic, 'a.bin'), generic)
    assert.equal(generic.type, 'application/octet-stream')
  })
})

// ── 以下是对 SFC 的结构断言 ────────────────────────────────────────────────

const sfcSource = readFileSync(join(root, 'app/components/FilePreviewer.vue'), 'utf8')
const { descriptor, errors } = parse(sfcSource, { filename: 'FilePreviewer.vue' })
const templateAst = descriptor.template?.ast
const script = descriptor.scriptSetup?.content ?? ''

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (node.type === 1) visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

const within = (node, tag) => {
  const found = []
  walk(node, (n) => {
    if (n.tag === tag) found.push(n)
  })
  return found
}

const collect = (tag) => {
  const found = []
  walk(templateAst, (n) => {
    if (n.tag === tag) found.push(n)
  })
  return found
}

const directiveExp = (node, name) => {
  const dir = (node.props ?? []).find((p) => p.type === 7 && p.name === name)
  return String(dir?.exp?.content ?? '')
}

const bound = (node, name) => {
  const dir = (node.props ?? []).find(
    (p) => p.type === 7 && p.name === 'bind' && p.arg?.content === name
  )
  return String(dir?.exp?.content ?? '')
}

const hasStaticAttr = (node, name) =>
  (node.props ?? []).some((p) => p.type === 6 && p.name === name)

const findBranch = (expr) => {
  const normalized = expr.replace(/\s+/g, ' ').trim()
  return collect('div').find(
    (n) => directiveExp(n, 'else-if').replace(/\s+/g, ' ').trim() === normalized
  )
}

describe('FilePreviewer 的媒体分支', () => {
  test('模板能解析', () => {
    assert.equal(errors.length, 0, errors.map((e) => e.message).join('; '))
  })

  test('视频：controls、playsinline、src 是缓存 blob，且不自动播放', () => {
    const branch = findBranch("activePreviewer === 'video'")
    assert.ok(branch, '没有 activePreviewer === video 的分支')
    const videos = within(branch, 'video')
    assert.equal(videos.length, 1, `视频分支里有 ${videos.length} 个 <video>`)
    const video = videos[0]
    assert.equal(bound(video, 'src'), 'blobUrl')
    assert.ok(hasStaticAttr(video, 'controls'), '没有 controls，用户没法播放')
    assert.ok(hasStaticAttr(video, 'playsinline'), 'iOS 上会强制全屏')
    assert.ok(!hasStaticAttr(video, 'autoplay'), '不能自动播放')
  })

  test('音频：controls、src 是缓存 blob，且不自动播放', () => {
    const branch = findBranch("activePreviewer === 'audio'")
    assert.ok(branch, '没有 activePreviewer === audio 的分支')
    const audios = within(branch, 'audio')
    assert.equal(audios.length, 1, `音频分支里有 ${audios.length} 个 <audio>`)
    const audio = audios[0]
    assert.equal(bound(audio, 'src'), 'blobUrl')
    assert.ok(hasStaticAttr(audio, 'controls'), '没有 controls，用户没法播放')
    assert.ok(!hasStaticAttr(audio, 'autoplay'), '不能自动播放')
  })

  test('整份模板里没有任何 autoplay', () => {
    for (const tag of ['video', 'audio']) {
      for (const el of collect(tag)) {
        assert.ok(!hasStaticAttr(el, 'autoplay'), `<${tag}> 上出现了 autoplay`)
      }
    }
  })

  test('压缩包内也能预览视频和音频，src 用解压后的 blob URL', () => {
    const videoBranch = findBranch('isZipEntryVideo && zipEntryBlobUrl')
    assert.ok(videoBranch, '压缩包内没有视频分支')
    const video = within(videoBranch, 'video')
    assert.equal(video.length, 1)
    assert.equal(bound(video[0], 'src'), 'zipEntryBlobUrl')
    assert.ok(hasStaticAttr(video[0], 'controls'))

    const audioBranch = findBranch('isZipEntryAudio && zipEntryBlobUrl')
    assert.ok(audioBranch, '压缩包内没有音频分支')
    const audio = within(audioBranch, 'audio')
    assert.equal(audio.length, 1)
    assert.equal(bound(audio[0], 'src'), 'zipEntryBlobUrl')
    assert.ok(hasStaticAttr(audio[0], 'controls'))
  })

  test('媒体字节走缓存，并补上 MIME', () => {
    assert.match(script, /import \{[^}]*\bwithMimeType\b[^}]*\} from '~\/utils\/mime'/, '没有引入 withMimeType')
    assert.match(script, /target === 'video' \|\| target === 'audio'/, '缓存分支漏了媒体')
    assert.match(
      script,
      /URL\.createObjectURL\(withMimeType\(blob, props\.file\?\.filename \?\? ''\)\)/,
      '媒体 blob URL 没有补 MIME'
    )
  })

  test('压缩包内媒体判定复用同一组扩展名表', () => {
    assert.match(script, /const isVideoName = \(filename: string\) => VIDEO_EXTENSIONS\.has\(extensionOf\(filename\)\)/)
    assert.match(script, /const isAudioName = \(filename: string\) => AUDIO_EXTENSIONS\.has\(extensionOf\(filename\)\)/)
    assert.match(script, /const isZipEntryVideo = computed\(\(\) => !!zipEntry\.value && isVideoName\(zipEntry\.value\.filename\)\)/)
    assert.match(script, /const isZipEntryAudio = computed\(\(\) => !!zipEntry\.value && isAudioName\(zipEntry\.value\.filename\)\)/)
  })
})
