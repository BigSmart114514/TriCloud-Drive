// 预览器选择（app/utils/previewer.ts + FilePreviewer.vue）。
//
// ## 为什么要拆出一个模块
//
// 项目里没有 @vue/test-utils / happy-dom / Playwright，SFC 挂不起来。所以
// 「打开一个 .png 默认选哪个预览器」「用户强制选图片后是不是真的用图片渲染」
// 这类判断如果留在组件里，就只能靠 grep 源码 —— 那断的是「某个名字出现过」，
// 不是「算出来是 image」。
//
// 于是把**所有会做决定的逻辑**放进 app/utils/previewer.ts，那一层直接 import
// 执行，断言具体取值。组件里只剩渲染，用 @vue/compiler-sfc 解析模板做结构断言
// （按钮里有没有残留文案、option 有没有被类型过滤掉）。
//
// ## 需求里的三个硬点
//
// 1. 下拉里**永远**列出全部预览器，不做「这个类型不适用所以不显示」的过滤 ——
//    用户明确要能对未知类型强行指定一个（比如没有扩展名其实是 PDF 的文件）。
// 2. 类型认得出来时自动选中默认预览器，不要求用户先点一下。
// 3. 认不出来时要提示选择，而不是掉进一句「暂不支持」了事。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const {
  PREVIEWERS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  TEXT_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  extensionOf,
  previewerFor,
  resolvePreviewer,
  isPreviewerId
} = await import('../app/utils/previewer.ts')

describe('PREVIEWERS：网站提供的全部预览器', () => {
  test('顺序与 id 固定，且只此九个', () => {
    assert.deepEqual(
      PREVIEWERS.map((p) => p.id),
      ['image', 'video', 'audio', 'pdf', 'text', 'code', 'zip', '7z', 'none']
    )
  })

  test('文案是 4–6 字，没有说明性长句', () => {
    for (const p of PREVIEWERS) {
      const len = [...p.label].length
      assert.ok(len >= 4 && len <= 6, `${p.id} 的 label「${p.label}」是 ${len} 字，要求 4–6`)
      assert.ok(!p.label.includes('**'), `${p.id} 的 label 漏出了 markdown 星号`)
    }
  })

  test('id 唯一（下拉的 :key 靠它）', () => {
    assert.equal(new Set(PREVIEWERS.map((p) => p.id)).size, PREVIEWERS.length)
  })
})

describe('extensionOf', () => {
  test('取最后一段扩展名并转小写', () => {
    assert.equal(extensionOf('Photo.PNG'), 'png')
    assert.equal(extensionOf('a.tar.gz'), 'gz')
  })

  test('没有扩展名或点结尾时是空串，不是整个文件名', () => {
    assert.equal(extensionOf('README'), '')
    assert.equal(extensionOf('a.'), '')
    assert.equal(extensionOf(''), '')
  })
})

describe('previewerFor：按扩展名给出默认预览器', () => {
  test('图片', () => {
    for (const name of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.svg', 'a.avif']) {
      assert.equal(previewerFor(name), 'image', name)
    }
  })

  test('视频', () => {
    for (const name of ['a.mp4', 'a.MP4', 'a.m4v', 'a.webm', 'a.ogv', 'a.mov', 'a.mkv']) {
      assert.equal(previewerFor(name), 'video', name)
    }
  })

  test('音频', () => {
    for (const name of ['a.mp3', 'a.MP3', 'a.wav', 'a.ogg', 'a.oga', 'a.m4a', 'a.aac', 'a.flac', 'a.opus', 'a.weba']) {
      assert.equal(previewerFor(name), 'audio', name)
    }
  })

  test('PDF', () => {
    assert.equal(previewerFor('a.pdf'), 'pdf')
    assert.equal(previewerFor('A.PDF'), 'pdf')
  })

  test('文本与 Markdown 都归 text', () => {
    for (const name of ['a.txt', 'a.log', 'a.csv', 'a.json', 'a.xml', 'a.yml', 'a.yaml', 'a.ini', 'a.env', 'a.md', 'a.markdown']) {
      assert.equal(previewerFor(name), 'text', name)
    }
  })

  test('.zip 归 zip，其余压缩包归 7z（含只给最后一段扩展名的多层后缀）', () => {
    assert.equal(previewerFor('a.zip'), 'zip')
    assert.equal(previewerFor('A.ZIP'), 'zip')
    for (const name of ['a.7z', 'a.rar', 'a.tar', 'a.gz', 'a.tgz', 'a.bz2', 'a.xz', 'a.zst', 'a.cpio', 'a.iso', 'a.deb', 'a.tar.gz']) {
      assert.equal(previewerFor(name), '7z', name)
    }
  })

  test('认不出来的返回 null —— 这正是要提示选择的场合', () => {
    for (const name of ['a.exe', 'a.docx', 'data', '', 'a.', 'a.bin']) {
      assert.equal(previewerFor(name), null, name)
    }
  })
})

describe('resolvePreviewer：用户选择优先，没选才用默认', () => {
  test('类型认得出来时不选就是默认', () => {
    assert.equal(resolvePreviewer('a.png', null), 'image')
    assert.equal(resolvePreviewer('a.md', null), 'text')
  })

  test('用户敢选就用用户的，哪怕类型对不上', () => {
    assert.equal(resolvePreviewer('a.png', 'pdf'), 'pdf')
    assert.equal(resolvePreviewer('a.exe', 'image'), 'image')
    assert.equal(resolvePreviewer('a.png', 'none'), 'none')
  })

  test('两台压缩引擎可以互相顶上', () => {
    // .zip 改坏了、.7z 其实是 zip —— 两个方向都要能手动换引擎重试。
    assert.equal(resolvePreviewer('a.zip', '7z'), '7z')
    assert.equal(resolvePreviewer('a.7z', 'zip'), 'zip')
    assert.equal(resolvePreviewer('noext', 'zip'), 'zip')
  })

  test('认不出来又没选 = 没有预览器（要提示选择）', () => {
    assert.equal(resolvePreviewer('a.exe', null), null)
  })
})

describe('isPreviewerId：挡住任意字符串', () => {
  test('认全部合法 id', () => {
    for (const p of PREVIEWERS) assert.equal(isPreviewerId(p.id), true, p.id)
  })

  test('大小写、空串、非字符串一律拒绝', () => {
    assert.equal(isPreviewerId('IMAGE'), false)
    assert.equal(isPreviewerId(''), false)
    assert.equal(isPreviewerId(null), false)
    assert.equal(isPreviewerId(undefined), false)
    assert.equal(isPreviewerId(3), false)
    assert.equal(isPreviewerId('nope'), false)
  })
})

describe('扩展名表本身', () => {
  test('五张表逐项固定', () => {
    // 整张表钉死，不是抽查几项。抽查漏掉的那一项，删掉时没有任何测试会响 ——
    // 第一版就漏了 cpio，而它唯一的间接覆盖是 previewerFor 里恰好列了这项。
    // 冷门格式收窄的表现只是「点开说暂不支持」，很难联想到是这里少了一项。
    assert.deepEqual([...IMAGE_EXTENSIONS].sort(), ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
    assert.deepEqual(
      [...VIDEO_EXTENSIONS].sort(),
      ['m4v', 'mkv', 'mov', 'mp4', 'ogv', 'webm']
    )
    assert.deepEqual(
      [...AUDIO_EXTENSIONS].sort(),
      ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba']
    )
    assert.deepEqual(
      [...TEXT_EXTENSIONS].sort(),
      ['csv', 'env', 'ini', 'json', 'log', 'markdown', 'md', 'txt', 'xml', 'yaml', 'yml']
    )
    assert.deepEqual(
      [...ARCHIVE_EXTENSIONS].sort(),
      ['7z', 'arj', 'bz2', 'cab', 'cpio', 'deb', 'dmg', 'gz', 'iso', 'lz', 'lzma', 'msi',
       'rar', 'rpm', 'tar', 'tbz', 'tbz2', 'tgz', 'txz', 'xar', 'xz', 'z', 'zip', 'zst']
    )
  })

  test('五张表都是非空 Set，且互不重叠', () => {
    const sets = [
      ['IMAGE', IMAGE_EXTENSIONS],
      ['VIDEO', VIDEO_EXTENSIONS],
      ['AUDIO', AUDIO_EXTENSIONS],
      ['TEXT', TEXT_EXTENSIONS],
      ['ARCHIVE', ARCHIVE_EXTENSIONS]
    ]
    for (const [name, set] of sets) {
      assert.ok(set instanceof Set, `${name} 必须是 Set`)
      assert.ok(set.size > 0, `${name} 不能为空`)
      for (const ext of set) assert.equal(ext, ext.toLowerCase(), `${name} 里的 ${ext} 必须是小写`)
    }
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        for (const ext of sets[i][1]) {
          assert.ok(!sets[j][1].has(ext), `${sets[i][0]} 表里的 ${ext} 不该同时出现在 ${sets[j][0]} 表`)
        }
      }
    }
  })
})

// ── 以下是对 SFC 的结构断言 ────────────────────────────────────────────────
// 没有挂载环境，所以这里断的是「模板解析出来的形状」：按钮里还有没有文案、
// option 有没有被类型条件挡住。语义（哪个类型用哪个预览器）由上面的模块测试
// 负责，不在这里重复。

const sfcSource = readFileSync(join(root, 'app/components/FilePreviewer.vue'), 'utf8')
const { descriptor, errors } = parse(sfcSource, { filename: 'FilePreviewer.vue' })
const templateAst = descriptor.template?.ast

const walkElements = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (node.type === 1) visit(node)
  for (const child of node.children ?? []) walkElements(child, visit)
}

const collectElements = (tag) => {
  const found = []
  walkElements(templateAst, (node) => {
    if (node.tag === tag) found.push(node)
  })
  return found
}

/**
 * 元素子树里「人眼能看见的文字」：文本节点 + {{ }} 插值。
 * 跳过 svg 子树 —— 图标内部不会有文案，但 path 的 d 属性不是文本节点，
 * 真要看也不会误判；跳过只是让意图明确。
 */
const visibleText = (node) => {
  let out = ''
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 2) out += n.content
    // 插值按 `{{ expr }}` 呈现：这样 option 的文案能逐字比对，而按钮里若还留着
    // 插值也会被算成「看得见的文字」而不是静默通过。
    else if (n.type === 5) out += `{{${n.content?.content ?? ''}}}`
    else if (n.type === 1) {
      if (n.tag === 'svg') return
      for (const c of n.children ?? []) walk(c)
    } else if (n.type === 0) {
      for (const c of n.children ?? []) walk(c)
    }
  }
  for (const c of node.children ?? []) walk(c)
  return out.trim()
}

const attrNames = (node) =>
  (node.props ?? []).filter((p) => p.type === 6).map((p) => p.name)

/** 指令（v-for / v-if / v-show …）在 AST 里是 type 7，name 不带 v- 前缀。 */
const directiveNames = (node) =>
  (node.props ?? []).filter((p) => p.type === 7).map((p) => p.name)

const directiveExp = (node, name) => {
  const dir = (node.props ?? []).find((p) => p.type === 7 && p.name === name)
  return String(dir?.exp?.content ?? '')
}

describe('FilePreviewer 顶栏按钮：全部换成图标', () => {
  test('模板能解析', () => {
    assert.equal(errors.length, 0, errors.map((e) => e.message).join('; '))
    assert.ok(templateAst, '没有 template')
  })

  test('每个 button 里没有任何可见文案（图标 + title 才允许）', () => {
    const buttons = collectElements('button')
    assert.ok(buttons.length >= 5, `按钮数量 ${buttons.length}，比预期的少 —— 是不是把入口删了`)
    for (const btn of buttons) {
      assert.equal(
        visibleText(btn),
        '',
        `有一个按钮仍然带文案：「${visibleText(btn)}」。图标按钮的说明应该放在 title/aria-label 里`
      )
    }
  })

  test('每个 button 都有 title 和 aria-label（图标按钮没有文字，只能靠它们）', () => {
    for (const btn of collectElements('button')) {
      const names = attrNames(btn)
      assert.ok(names.includes('title'), `按钮缺少 title：${names.join(',')}`)
      assert.ok(names.includes('aria-label'), `按钮缺少 aria-label：${names.join(',')}`)
    }
  })
})

describe('FilePreviewer 的预览器下拉', () => {
  test('四个 select：预览器、文本编码、代码语言、代码主题', () => {
    // 编码下拉由 tests/text-encoding.test.mjs 负责，语言与主题下拉由
    // tests/code-previewer.test.mjs 负责，这里只钉住总数，
    // 免得「下拉被复制了一份」这种改动溜过去。
    assert.equal(collectElements('select').length, 4)
  })

  test('option 来自 PREVIEWERS 的 v-for，且没有被条件挡住', () => {
    const options = collectElements('option')
    const looped = options.filter((o) => directiveExp(o, 'for').replace(/\s+/g, ' ') === 'p in PREVIEWERS')
    assert.equal(looped.length, 1, '应该只有一个 option 负责遍历预览器表')
    const option = looped[0]
    const expr = directiveExp(option, 'for').replace(/\s+/g, ' ')
    assert.match(expr, /^(\w+) in PREVIEWERS$/, `v-for 必须直接遍历 PREVIEWERS，实际是「${expr}」`)
    // 文案必须是插值取注册表里的 label，不能写死一份平行清单。
    const kids = (option.children ?? []).filter((c) => c.type === 5 || (c.type === 2 && c.content.trim()))
    assert.equal(kids.length, 1, 'option 里应该只有一处插值')
    assert.equal(kids[0].type, 5, 'option 的文案必须是插值，不能是写死的字')
    assert.equal(kids[0].content?.content?.trim(), 'p.label', 'option 的文案必须直接取注册表里的 label')
  })

  test('option 上没有 v-if / v-show（要求是永远列出全部，不按类型过滤）', () => {
    for (const option of collectElements('option')) {
      const dirs = directiveNames(option)
      assert.ok(!dirs.includes('if'), `option 被 v-if 过滤了：${dirs.join(',')}`)
      assert.ok(!dirs.includes('show'), `option 被 v-show 过滤了：${dirs.join(',')}`)
    }
  })

  test('script 从 util 引入注册表与判定函数', () => {
    const script = descriptor.scriptSetup?.content ?? ''
    assert.match(script, /from '~\/utils\/previewer'/, '没有从 ~/utils/previewer 引入')
    for (const name of ['PREVIEWERS', 'resolvePreviewer', 'isPreviewerId']) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(script), `script 里没有用到 ${name}`)
    }
  })

  test('预览器选择不会被写死成某一个（必须走 resolvePreviewer）', () => {
    const script = descriptor.scriptSetup?.content ?? ''
    assert.match(script, /resolvePreviewer\s*\(/, '没有调用 resolvePreviewer —— 默认预览器就无从谈起')
  })

  /*
   * 「切换预览器不重新下载」这条属性由 tests/preview-source.test.mjs 真跑缓存来保证。
   * 但那管不到组件绕过缓存自己发请求 —— 界面上看不出区别，只是一次大文件悄悄传两遍。
   * 所以这里断几个**调用计数**：网络原语只允许出现在约定位置，多一处就说明有人
   * 又开了一条下载路径。
   */
  test('字节只从缓存层取，没有第二条预览下载路径', () => {
    const script = descriptor.scriptSetup?.content ?? ''
    assert.match(script, /createPreviewSource\s*\(/, '没有接上缓存层')

    const signs = (script.match(/FilesService\.downloadSign\s*\(/g) ?? []).length
    assert.equal(signs, 2, `downloadSign 应该只有两处（缓存层 + 显式下载），实际 ${signs} 处`)

    const fetches = (script.match(/\bfetch\s*\(/g) ?? []).length
    assert.equal(fetches, 2, `fetch 应该只有两处（缓存层 + 显式下载），实际 ${fetches} 处`)

    // invalidate 只该出现在卸载清理里。切换预览器时调它等于把缓存当场作废，
    // 下次切换又得重新下载 —— 这正是要防的那件事。
    const invalids = (script.match(/\binvalidate\b/g) ?? []).length
    assert.equal(invalids, 1, `invalidate 只该出现在卸载清理里，实际 ${invalids} 处`)
  })
})

describe('FilePreviewer 的压缩包分支：两台引擎各自成条', () => {
  const exprOf = (node, name) => directiveExp(node, name).replace(/\s+/g, ' ').trim()

  test('ZipPreview 与 SevenZipPreview 各挂一次，条件互斥', () => {
    const zip = collectElements('ZipPreview')
    const seven = collectElements('SevenZipPreview')
    assert.equal(zip.length, 1, `ZipPreview 出现了 ${zip.length} 次`)
    assert.equal(seven.length, 1, `SevenZipPreview 出现了 ${seven.length} 次`)

    assert.equal(exprOf(zip[0], 'if'), "archiveBlob && activePreviewer === 'zip'")
    assert.equal(exprOf(seven[0], 'if'), "archiveBlob && activePreviewer === '7z'")
    // 包内文件打开时两个列表都要让位，不能只藏一个。
    assert.equal(exprOf(zip[0], 'show'), '!zipEntry')
    assert.equal(exprOf(seven[0], 'show'), '!zipEntry')
  })

  test('外层 else-if 同时接住 zip 与 7z', () => {
    const wrappers = collectElements('div').filter((d) => exprOf(d, 'else-if').includes("activePreviewer === 'zip'"))
    assert.equal(wrappers.length, 1, '没有找到同时包含两台引擎的外层分支')
    assert.equal(exprOf(wrappers[0], 'else-if'), "activePreviewer === 'zip' || activePreviewer === '7z'")
  })

  test('script 里不再按扩展名在运行时二选一', () => {
    const script = descriptor.scriptSetup?.content ?? ''
    assert.doesNotMatch(script, /archiveFormat/, 'archiveFormat 又把两台引擎合并回一个隐藏开关了')
    assert.doesNotMatch(script, /=== 'archive'/, '还留着旧的 archive id')
    assert.match(script, /target === 'zip' \|\| target === '7z'/, '缓存字节那条路要同时认两台引擎')
  })
})
