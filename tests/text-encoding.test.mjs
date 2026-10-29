// 文本预览的编码（app/utils/text-encoding.ts + FilePreviewer.vue）。
//
// ## 为什么解码、编码要拆成模块
//
// 项目里没有挂载 SFC 的环境，编码逻辑留在组件里就只能 grep 源码。拆出来之后
// 「GBK 的两个字节解成什么」「UTF-16 写出去带不带 BOM」「GBK 写不了 emoji 时
// 是抛还是静默替换」都能真跑、断言具体字节。
//
// ## 反查表是算出来的，所以必须对着已知字节验一次
//
// encodeText 不查 iconv 表，而是把每个字节序列丢给 TextDecoder 解一遍、反过来
// 建「字 → 字节」。这条路如果遍历范围写错（lead/trail 少一段），表现为「某些字
// 保存时报写不了」，很难联想到是这里的边界。所以既钉死几个已知字节，也做整段
// 往返。
//
// ## SFC 部分断的是调用形状
//
// 「换编码不重新下载」由 preview-source 的缓存真跑保证；这里只钉组件确实走
// decodeText/encodeText、且换编码只调 load()（load 取数走缓存），没有另开
// fetch / downloadSign / source.get。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const {
  TEXT_ENCODINGS,
  DEFAULT_TEXT_ENCODING,
  isTextEncodingId,
  decodeText,
  encodeText,
  UnencodableCharacterError
} = await import('../app/utils/text-encoding.ts')

const previewerModule = await import('../app/utils/previewer.ts')

const bytesOf = (source, encoding) => [...encodeText(source, encoding)]
const hex = (values) => values.map((b) => b.toString(16).padStart(2, '0')).join(' ')

describe('TEXT_ENCODINGS：下拉里的编码', () => {
  test('顺序与 id 固定', () => {
    assert.deepEqual(
      TEXT_ENCODINGS.map((e) => e.id),
      ['utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'utf-16le', 'utf-16be']
    )
  })

  test('默认是 UTF-8，而且必须是列表里的第一项', () => {
    assert.equal(DEFAULT_TEXT_ENCODING, 'utf-8')
    assert.equal(TEXT_ENCODINGS[0].id, DEFAULT_TEXT_ENCODING)
  })

  test('id 唯一，label 非空且不含 markdown 星号', () => {
    assert.equal(new Set(TEXT_ENCODINGS.map((e) => e.id)).size, TEXT_ENCODINGS.length)
    for (const e of TEXT_ENCODINGS) {
      assert.ok(e.label.length > 0, `${e.id} 没有 label`)
      assert.ok(!e.label.includes('**'), `${e.id} 的 label 漏出了 markdown 星号`)
    }
  })

  test('isTextEncodingId 只认登记过的 id', () => {
    for (const e of TEXT_ENCODINGS) assert.equal(isTextEncodingId(e.id), true, e.id)
    for (const bad of ['UTF-8', 'gb2312', '', 'utf8', null, undefined, 3, {}]) {
      assert.equal(isTextEncodingId(bad), false, String(bad))
    }
  })
})

describe('decodeText：按编码解字节', () => {
  test('UTF-8 中文与 emoji', () => {
    const bytes = new TextEncoder().encode('中文 😀')
    assert.equal(decodeText(bytes, 'utf-8'), '中文 😀')
  })

  test('GBK 的「你」是 C4 E3', () => {
    assert.equal(decodeText(new Uint8Array([0xc4, 0xe3]), 'gbk'), '你')
  })

  test('GB18030 覆盖 GBK 的双字节区', () => {
    assert.equal(decodeText(new Uint8Array([0xc4, 0xe3]), 'gb18030'), '你')
  })

  test('UTF-16 的大小端是反的，选错就是另一个字', () => {
    assert.equal(decodeText(new Uint8Array([0x2d, 0x4e]), 'utf-16le'), '中')
    assert.equal(decodeText(new Uint8Array([0x4e, 0x2d]), 'utf-16be'), '中')
  })

  test('BOM 不显示成正文（UTF-8 与 UTF-16 LE 都剥）', () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a')])
    assert.equal(decodeText(utf8, 'utf-8'), 'a')
    assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e]), 'utf-16le'), '中')
  })

  test('非法字节变成 U+FFFD，不抛 —— 选错编码应该看得见而不是报错', () => {
    assert.equal(decodeText(new Uint8Array([0x80, 0xff]), 'utf-8'), '\uFFFD\uFFFD')
  })
})

describe('encodeText：编回字节', () => {
  test('UTF-8 与 TextEncoder 一致', () => {
    const text = '中文 😀\n'
    assert.deepEqual(bytesOf(text, 'utf-8'), [...new TextEncoder().encode(text)])
  })

  test('GBK 的「你好」是 C4 E3 BA C3', () => {
    assert.equal(hex(bytesOf('你好', 'gbk')), 'c4 e3 ba c3')
  })

  test('ASCII 在 legacy 编码里是单字节直通', () => {
    assert.equal(hex(bytesOf('aZ0 ~', 'gbk')), '61 5a 30 20 7e')
    assert.equal(hex(bytesOf('aZ0 ~', 'big5')), '61 5a 30 20 7e')
  })

  test('Shift_JIS 的单字节半角片假名在反查表里（双字节扫描覆盖不到）', () => {
    // ｱ 是 U+FF71，Shift_JIS 单字节 0xB1。
    assert.equal(hex(bytesOf('ｱ', 'shift_jis')), 'b1')
    assert.equal(decodeText(new Uint8Array([0xb1]), 'shift_jis'), 'ｱ')
  })

  test('UTF-16 写出去带 BOM，大小端各自正确', () => {
    assert.equal(hex(bytesOf('中', 'utf-16le')), 'ff fe 2d 4e')
    assert.equal(hex(bytesOf('中', 'utf-16be')), 'fe ff 4e 2d')
  })

  test('每种编码都能原样往返', () => {
    const corpus = {
      'utf-8': '中文，。！ abc 😀',
      gbk: '中文，。！ abc',
      gb18030: '中文，。！ abc',
      big5: '中文測試 abc',
      shift_jis: 'こんにちはｱｲｳ abc',
      'utf-16le': '中文 abc 😀',
      'utf-16be': '中文 abc 😀'
    }
    for (const [encoding, text] of Object.entries(corpus)) {
      assert.equal(decodeText(encodeText(text, encoding), encoding), text, encoding)
    }
  })

  test('已知字节 → 解码 → 编码，字节不变（反查表没有把同义字串错）', () => {
    const vectors = [
      ['gbk', [0xc4, 0xe3, 0xba, 0xc3]],
      ['gb18030', [0xd6, 0xd0, 0xce, 0xc4]],
      ['big5', [0xa4, 0xa4, 0xa4, 0xe5]],
      ['shift_jis', [0x93, 0xfa, 0x96, 0x7b]],
      ['utf-16le', [0xff, 0xfe, 0x2d, 0x4e]],
      ['utf-16be', [0xfe, 0xff, 0x4e, 0x2d]]
    ]
    for (const [encoding, bytes] of vectors) {
      const text = decodeText(new Uint8Array(bytes), encoding)
      assert.equal(hex(bytesOf(text, encoding)), hex(bytes), `${encoding} ${JSON.stringify(text)}`)
    }
  })

  test('写不下的字抛 UnencodableCharacterError，带上是哪个字', () => {
    assert.throws(
      () => encodeText('a😀b', 'gbk'),
      (err) => {
        assert.ok(err instanceof UnencodableCharacterError)
        assert.equal(err.char, '😀')
        assert.equal(err.encoding, 'gbk')
        assert.ok(err.message.includes('😀'), '报错里要指出是哪个字')
        assert.ok(err.message.includes('UTF-8'), '要告诉用户改用 UTF-8')
        return true
      }
    )
  })

  test('同样的字在 UTF-8 下写得出来（不是无条件拒绝）', () => {
    assert.equal(decodeText(encodeText('😀', 'utf-8'), 'utf-8'), '😀')
  })
})

// ── SFC：调用形状 ─────────────────────────────────────────────────────────

const sfcSource = readFileSync(join(root, 'app/components/FilePreviewer.vue'), 'utf8')
const { descriptor, errors } = parse(sfcSource, { filename: 'FilePreviewer.vue' })
const templateAst = descriptor.template?.ast
const script = descriptor.scriptSetup?.content ?? ''

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (node.type === 1) visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

const collectElements = (tag) => {
  const found = []
  walk(templateAst, (node) => {
    if (node.tag === tag) found.push(node)
  })
  return found
}

const directiveExp = (node, name) =>
  String((node.props ?? []).find((p) => p.type === 7 && p.name === name)?.exp?.content ?? '')

const attrNames = (node) => (node.props ?? []).filter((p) => p.type === 6).map((p) => p.name)
const staticAttr = (node, name) =>
  (node.props ?? []).find((p) => p.type === 6 && p.name === name)?.value?.content ?? ''
const bound = (node, arg) =>
  String((node.props ?? []).find((p) => p.type === 7 && p.name === 'bind' && p.arg?.content === arg)?.exp?.content ?? '')

/** 从某个标记切到另一个标记，避免在整段 script 里做宽松匹配。 */
const sliceBetween = (start, end) => {
  const from = script.indexOf(start)
  assert.ok(from >= 0, `script 里找不到「${start}」`)
  const to = script.indexOf(end, from + start.length)
  assert.ok(to > from, `script 里找不到「${end}」`)
  return script.slice(from, to)
}

describe('FilePreviewer：空文件的提示', () => {
  test('空字节解码得到空字符串，不是还要等的内容', () => {
    assert.equal(decodeText(new Uint8Array(new ArrayBuffer(0)), 'utf-8'), '')
  })

  test('空文件提示说明「这里是空的」，不冒充加载状态', () => {
    const hint = previewerModule.EMPTY_TEXT_PLACEHOLDER
    assert.equal(hint, '空文件，可直接输入')
    assert.ok(!hint.includes('加载'), `空文件没有内容可等，提示里不能写「加载」：${hint}`)
  })

  test('textarea 的 placeholder 用的是这个常量，且没有残留的加载文案', () => {
    const textarea = collectElements('textarea').find(
      (node) => directiveExp(node, 'model') === 'textContent'
    )
    assert.ok(textarea, '没有找到文本编辑框')
    assert.equal(bound(textarea, 'placeholder'), 'EMPTY_TEXT_PLACEHOLDER')
    assert.equal(staticAttr(textarea, 'placeholder'), '', '占位符要绑定常量，不能写死')
    const previewerImport = sliceBetween('import {\n  PREVIEWERS', "} from '~/utils/previewer'")
    assert.match(previewerImport, /\bEMPTY_TEXT_PLACEHOLDER\b/, '组件没有引入这个常量')
    assert.ok(
      !sfcSource.includes('正在加载内容'),
      '「正在加载内容...」在空文件上会一直显示，必须删掉'
    )
  })
})

describe('FilePreviewer：文本模式的编辑与编码', () => {
  test('模板与脚本能解析', () => {
    assert.equal(errors.length, 0, errors.map((e) => e.message).join('; '))
    assert.ok(templateAst, '没有 template')
    assert.ok(script.length > 0, '没有 script setup')
  })

  test('可编辑只看视角，不再要求扩展名是文本（这是上次丢掉编辑的原因）', () => {
    assert.match(
      script,
      /const isEditable = computed\(\(\) => !linkMode\.value && \(activePreviewer\.value === 'text' \|\| activePreviewer\.value === 'code'\)\)/,
      'isEditable 必须正好是「不是链接视角 + 当前是文本或代码预览器」'
    )
    assert.doesNotMatch(script, /defaultPreviewer/, '按扩展名卡编辑权的判定已经被删掉了')
  })

  test('文本分支只有一个，textarea 与只读 pre 由 isEditable 二选一', () => {
    const isTextLike = (d) => {
      const exp = directiveExp(d, 'else-if').replace(/\s+/g, ' ').trim()
      return exp === "activePreviewer === 'text' || activePreviewer === 'code'"
    }
    const branches = collectElements('div').filter(isTextLike)
    assert.equal(branches.length, 1, `文本分支应该有且只有一个，实际 ${branches.length}`)

    const textareas = []
    const pres = []
    walk(branches[0], (node) => {
      if (node.tag === 'textarea') textareas.push(node)
      if (node.tag === 'pre') pres.push(node)
    })
    assert.equal(textareas.length, 1)
    assert.equal(pres.length, 1)
    // 代码预览器占了 v-if，文本的编辑框排在它后面，所以这里是 v-else-if。
    assert.equal(directiveExp(textareas[0], 'else-if'), 'isEditable')
    // 必须是**存在**的 v-else：只断 exp 为空的话，把 v-else 改成 v-if 也是空，
    // 两个分支会同时渲染（textarea 和 pre 都在）。
    assert.ok(
      (pres[0].props ?? []).some((p) => p.type === 7 && p.name === 'else'),
      '只读分支必须是 v-else，否则会和 textarea 同时出现'
    )
    assert.equal(directiveExp(textareas[0], 'model'), 'textContent')
    assert.ok(!attrNames(textareas[0]).includes('readonly'), '可编辑分支的 textarea 不能是 readonly')
  })

  test('编码下拉列出全部编码，文案取注册表，不是另一份写死的清单', () => {
    const encodingSelects = collectElements('select').filter((s) => {
      const options = (s.children ?? []).filter((c) => c.type === 1 && c.tag === 'option')
      return options.some((o) => directiveExp(o, 'for').replace(/\s+/g, ' ') === 'e in TEXT_ENCODINGS')
    })
    assert.equal(encodingSelects.length, 1)
    const select = encodingSelects[0]
    assert.equal(bound(select, 'value'), 'encoding')
    // 有未保存修改时不禁用：那样会变成「必须先把乱码存一遍才能换编码」。
    // 交给 pickEncoding 里的 confirm 问一句。
    assert.equal(bound(select, 'disabled'), 'loading')
    assert.ok(attrNames(select).includes('title'))
    assert.ok(attrNames(select).includes('aria-label'))

    const option = (select.children ?? []).find((c) => c.type === 1 && c.tag === 'option')
    const interpolations = (option.children ?? []).filter((c) => c.type === 5)
    assert.equal(interpolations.length, 1)
    assert.equal(interpolations[0].content?.content?.trim(), 'e.label')
  })

  test('编码下拉在文本分支里，且没有被 v-if 挡住（只读视角也要能换编码看）', () => {
    const branch = collectElements('div').find(
      (d) => directiveExp(d, 'else-if').replace(/\s+/g, ' ').trim() === "activePreviewer === 'text' || activePreviewer === 'code'"
    )
    assert.ok(branch, '没有找到 text/code 合并分支')
    let found = null
    walk(branch, (node) => {
      if (node.tag === 'select' && attrNames(node).includes('title') && (node.children ?? []).some(
        (c) => c.type === 1 && c.tag === 'option' && directiveExp(c, 'for').includes('TEXT_ENCODINGS')
      )) found = node
    })
    assert.ok(found, '合并分支里没有编码下拉')
    assert.ok(!(found.props ?? []).some((p) => p.type === 7 && (p.name === 'if' || p.name === 'show')))
  })

  test('解码走 decodeText，不用 Blob.text() 的固定 UTF-8', () => {
    const render = sliceBetween('const renderPreview =', 'const load = async')
    assert.match(render, /decodeText\(new Uint8Array\(await blob\.arrayBuffer\(\)\), encoding\.value\)/)
    assert.doesNotMatch(render, /blob\.text\(\)/)
  })

  test('保存按选中的编码写回，不是固定 UTF-8', () => {
    const save = sliceBetween('const saveText =', 'const handlePickReplacement =')
    assert.match(save, /encodeText\(textContent\.value, encoding\.value\)/)
    assert.doesNotMatch(save, /new Blob\(\[textContent\.value\]/, '直接把字符串塞进 Blob 等于固定 UTF-8')
  })

  test('换编码重新解缓存里的字节：只调 load()，不另开下载路径', () => {
    const pick = sliceBetween('const pickEncoding =', 'watch(() => props.file?.id')
    assert.match(pick, /void load\(\)/)
    assert.match(pick, /confirm\(/, '有未保存修改时要先问一句')
    assert.doesNotMatch(pick, /\bfetch\s*\(|downloadSign|source\.get/)
  })

  test('初始编码是默认值', () => {
    assert.match(script, /const encoding = ref<TextEncodingId>\(DEFAULT_TEXT_ENCODING\)/)
  })

  test('换文件时编码回到默认，不带着上一个文件的编码', () => {
    const watchBlock = sliceBetween('watch(() => props.file?.id', '{ immediate: true })')
    assert.match(watchBlock, /encoding\.value = DEFAULT_TEXT_ENCODING/)
  })

  test('编码列表与判定从 util 引入', () => {
    const importBlock = sliceBetween('import {\n  TEXT_ENCODINGS', "} from '~/utils/text-encoding'")
    for (const name of ['TEXT_ENCODINGS', 'DEFAULT_TEXT_ENCODING', 'decodeText', 'encodeText', 'isTextEncodingId']) {
      assert.match(importBlock, new RegExp(`\\b${name}\\b`), `没有从 util 引入 ${name}`)
    }
    assert.match(importBlock, /type TextEncodingId/, 'TextEncodingId 是类型，要带 type 引入')
  })
})
