// 拖拽上传：分类判据的行为测试 + 接线断言。跑真函数，不抄一份。
//
// ## 为什么核心是行为测试
//
// 要守住的判据是「拖纯文件时一次都不许调 webkitGetAsEntry」。这条用源码正则
// 断言不住 —— 正则看得见「有个 classifyDrop 调用」，看不见「它有没有把
// item 送进 getFilesFromEntries」。而送进去的后果是 Chrome 把每个文件实体化成
// 沙箱副本（macOS 上用户能在 ~/Downloads 里看到），长传时还会触发
// net::ERR_UPLOAD_FILE_CHANGED，SDK 把它错报成 'CORS blocked or network error'。
//
// 所以判据函数直接 import 来调，接线部分另用源码断言钉住「files 在 items 之前读」
// 与「每个 item 只实体化一次」—— 这两条本来就只能从源码看。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { classifyDrop, entriesFromWebkitRelativePath, normalizeDir, toPosix } =
  await import('../app/utils/drop.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const DND = 'app/composables/useDnDUpload.ts'

/** 剥注释，免得注释里出现的类名/函数名把判定带偏 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

const file = (name) => ({ kind: 'file', type: 'text/plain', name })
const dir = () => ({ kind: 'file', type: '', name: 'someDir' })
const text = () => ({ kind: 'string', type: 'text/plain' })

describe('分类：拖纯文件时不该有任何 item 需要实体化', () => {
  // 这是整个改动的核心。原来的 `.some(it.webkitGetAsEntry()?.isDirectory)`
  // 为了确认「没有目录」必须把每一个都问一遍，于是每个都产生一份沙箱副本。
  test('单个文件 → files 模式，needsEntry 为空', () => {
    const r = classifyDrop([file('a.txt')])
    assert.equal(r.mode, 'files')
    assert.deepEqual(r.needsEntry, [], '不许要求实体化：这就是 ~/Downloads 副本的来源')
  })

  test('多个文件 → 仍然全部不进 needsEntry', () => {
    const r = classifyDrop([file('a.txt'), file('b.pdf'), file('c.png')])
    assert.equal(r.mode, 'files')
    assert.equal(r.needsEntry.length, 0, '文件再多也不该有任何 item 被实体化')
  })

  test('MIME 已知与未知（MIME）都不进 needsEntry', () => {
    const items = [
      { kind: 'file', type: 'application/pdf' },
      { kind: 'file', type: 'image/png' },
      { kind: 'file', type: 'video/mp4' }
    ]
    assert.equal(classifyDrop(items).needsEntry.length, 0)
  })

  // kind !== 'file' 的是拖进来的文本/URL，dataTransfer.files 里根本没有它们，
  // 不该为它们付出实体化的代价。
  test('kind=string（拖文本/URL）不进 needsEntry', () => {
    const r = classifyDrop([text()])
    assert.equal(r.mode, 'files')
    assert.equal(r.needsEntry.length, 0)
  })
})

describe('分类：目录必须被认出来', () => {
  // 目录的 kind 也是 'file'（它确实是个可拖的条目），区别在 type 为空串。
  test('空 type 的 item → dirs 模式', () => {
    const r = classifyDrop([dir()])
    assert.equal(r.mode, 'dirs')
    assert.equal(r.needsEntry.length, 1)
  })

  test('目录与文件混着拖 → 只有目录进 needsEntry', () => {
    const r = classifyDrop([file('a.txt'), dir(), file('b.txt')])
    assert.equal(r.mode, 'dirs')
    assert.equal(r.needsEntry.length, 1, '只有目录需要实体化，普通文件不该被牵连')
    assert.deepEqual(r.needsEntry.map((i) => i.name), ['someDir'])
  })

  // 反过来的顺序也要对：.some() 只在遇到第一个目录时短路，
  // 所以「目录在最后」正是原代码代价最大的形状。
  test('目录排在最后也一样只挑出目录', () => {
    const r = classifyDrop([file('a'), file('b'), dir()])
    assert.equal(r.mode, 'dirs')
    assert.deepEqual(r.needsEntry.map((i) => i.name), ['someDir'])
  })
})

describe('分类：退化情形不能崩，也不能白实体化', () => {
  test('items 为空 → files 模式（与「只有纯文件」同路）', () => {
    const r = classifyDrop([])
    assert.equal(r.mode, 'files')
    assert.equal(r.needsEntry.length, 0)
  })

  test('null / undefined 的 items 也不崩', () => {
    // handleDrop 拿到的可能真是 undefined（合成事件、非浏览器环境）
    for (const bad of [null, undefined]) {
      assert.doesNotThrow(() => classifyDrop(bad ?? []))
    }
  })

  // 关键：退化时 **不能** 返回「全部需要实体化」。那等于把旧 bug 换了个写法 ——
  // 用户拖 1 个文件，我们去实体化它，于是又出现沙箱副本；而 dirs 模式在
  // handleDrop 里还会**早退**（`if (entries.length) return`），实体化失败时
  // 连 .files 那条兜底都走不到。
  test('退化时走 files 模式（而不是 dirs）', () => {
    const r = classifyDrop([])
    assert.equal(r.mode, 'files', '空 items 若判成 dirs，handleDrop 会去实体化并可能直接 return 掉 .files 兜底')
    assert.equal(r.needsEntry.length, 0)
  })

  // 更一般的形态：**输入里没有目录时，一个都不许实体化。**
  //
  // 「不把全部送出去」这条更弱的说法不成立 —— 拖一个目录进来时 needsEntry
  // 必然等于 items（要保层级只能走 entry 这条会实体化的路）。所以不变式只能
  // 收窄到「无目录 ⇒ 零实体化」，而那正好就是旧 bug 的核心：
  // 原来的 .some() 为了确认「没有目录」而问遍每一个 item，于是每个都产生副本。
  test('没有目录时，一个都不实体化', () => {
    const dirless = [
      [],
      [file('a')],
      [file('a'), file('b'), file('c')],
      [text(), file('a')],
      [{ kind: 'file', type: 'application/pdf' }],
      [{ kind: 'file', type: 'text/plain' }, { kind: 'file', type: 'image/png' }]
    ]
    for (const items of dirless) {
      const r = classifyDrop(items)
      const label = JSON.stringify(items.map((i) => ({ k: i.kind, t: i.type })))
      assert.equal(r.mode, 'files', `${label} 不该被判成 dirs`)
      assert.equal(r.needsEntry.length, 0, `${label} 不该有任何 item 被实体化`)
    }
  })

  // 互补的一面：真有目录时，那一批**必须**被实体化，否则目录结构会丢。
  // 上面那条不能收得太狠，否则就把功能也砍了。
  test('有目录时那一批一定被实体化（目录结构不能丢）', () => {
    const withDirs = [
      [dir()],
      [file('a'), dir()],
      [dir(), file('a'), file('b')],
      [file('a'), dir(), file('b'), dir()]
    ]
    for (const items of withDirs) {
      const r = classifyDrop(items)
      assert.equal(r.mode, 'dirs')
      assert.ok(r.needsEntry.length > 0, '有目录却一个都不实体化 = 层级被丢弃')
      // 每个疑似目录（type 为空）都必须在里面
      for (const item of items) {
        if (item.kind === 'file' && !item.type) {
          assert.ok(r.needsEntry.includes(item), '漏掉了某个疑似目录')
        }
      }
    }
  })

  test('缺 kind 的 item 按 kind !== file 处理（不进 needsEntry）', () => {
    // 合成事件或老浏览器可能连 kind 都没有。此时保守走 files 路。
    const r = classifyDrop([{ type: '' }])
    assert.equal(r.mode, 'files')
    assert.equal(r.needsEntry.length, 0)
  })
})

describe('路径归一：两个入口必须一致', () => {
  test('toPosix 把 Windows 分隔符换成 /', () => {
    assert.equal(toPosix('a\\b\\c.txt'), 'a/b/c.txt')
    assert.equal(toPosix('a/b/c.txt'), 'a/b/c.txt')
  })

  test('normalizeDir 去首尾斜杠', () => {
    assert.equal(normalizeDir('/a/b/'), 'a/b')
    assert.equal(normalizeDir('a/b'), 'a/b')
    assert.equal(normalizeDir('//a//b//'), 'a//b', '只去首尾，中间不动 —— 那会让真实目录名对不上')
    assert.equal(normalizeDir(''), '')
  })

  // entriesFromWebkitRelativePath 是从 handleFolderSelect 搬出来的，
  // 搬的时候逐字保住了行为 —— 这些断言就是那层保证。
  test('webkitRelativePath 的目录部分被取出', () => {
    const f = (rp) => ({ webkitRelativePath: rp, name: rp.split('/').pop() })
    const out = entriesFromWebkitRelativePath([f('proj/src/a.ts'), f('proj/b.ts')])
    assert.deepEqual(out.map((e) => e.relativePath), ['proj/src', 'proj'])
  })

  test('没有 webkitRelativePath 时回落到文件名，且目录为空（= 落到当前目录）', () => {
    // 这与拖拽路径下「纯文件 → 落到当前目录」的行为一致：
    // 两边对「没有相对路径」的处理必须一样，否则同一批文件从两个入口进来落点不同。
    const out = entriesFromWebkitRelativePath([{ name: 'a.txt' }])
    assert.deepEqual(out.map((e) => e.relativePath), [''])
  })

  test('只有一层目录时 relativePath 不带尾斜杠', () => {
    const out = entriesFromWebkitRelativePath([{ webkitRelativePath: 'd/a.txt', name: 'a.txt' }])
    assert.deepEqual(out.map((e) => e.relativePath), ['d'])
  })

  test('文件对象原样透传（不被复制）', () => {
    const file = { webkitRelativePath: 'd/a.txt', name: 'a.txt', size: 5 }
    const out = entriesFromWebkitRelativePath([file])
    assert.equal(out[0].file, file, '要传的是同一个对象：复制会丢掉 File 的内部句柄')
  })
})

describe('接线：时序与「只实体化一次」只能从源码看', () => {
  test('dataTransfer.files 在 items 之前读', () => {
    const src = codeOnly(read(DND))
    const itemsAt = src.indexOf('event.dataTransfer?.items')
    const filesAt = src.indexOf('event.dataTransfer?.files')
    assert.ok(itemsAt > 0 && filesAt > 0, '两处都得找得到')
    // 判据函数在这两次读取之间，不影响顺序；关键是 files 那次不在 items 之前
    assert.ok(
      itemsAt < filesAt,
      '必须先取 .items（喂给 classifyDrop）再取 .files —— ' +
        '反过来的话读 .files 时 item 可能已被锁进 protected 状态拿到空列表'
    )
  })

  // 原来 .some() 调一次、getFilesFromDataTransferItems 里又调一次，
  // 第二次返回 null 被 `if (!entry) continue` 静默跳过 → 拖文件夹漏文件且不报错。
  test('webkitGetAsEntry 在正文里只出现一次', () => {
    const src = codeOnly(read(DND))
    const calls = [...src.matchAll(/\.webkitGetAsEntry\(\)/g)]
    assert.equal(
      calls.length,
      1,
      `正文里只该有一次实际调用（每个 item 一次），实际 ${calls.length} 次。` +
        '重复调用会在已消费 item 上拿到 null，被静默跳过'
    )
  })

  test('classifyDrop 的结果直接喂给实体化，不经过任何「再取全部 items」的中间层', () => {
    const src = codeOnly(read(DND))
    assert.match(
      src,
      /const \{ mode, needsEntry \} = classifyDrop\(items\)/,
      '必须解出 needsEntry 并用它，不能只判 mode 然后把全部 items 传下去'
    )
    assert.match(
      src,
      /getFilesFromEntries\(needsEntry\)/,
      '实体化的必须是 needsEntry（筛过的那批），不是 items'
    )
  })

  // 「dirs 模式下实体化失败要退回 .files」：否则不支持 entry 的浏览器上
  // 拖文件夹会静默什么都不做 —— 用户看到的是「拖了没反应」。
  //
  // 两条分开断言，而且**必须卡在 if 块内部**：
  // 第一版把「拿到东西」和「往下走」写成一条正则，中间用 [\s\S]*? 连着。
  // 结果把 `return` 删掉（实体化成功后也继续走 .files，于是同一批文件被上传
  // 两次）那条正则照样匹配 —— 它把 return 和后面的兜底一起吞掉了。
  test('dirs 分支：拿到条目就 return，不重复走 .files', () => {
    const src = codeOnly(read(DND))
    const dirsAt = src.indexOf("mode === 'dirs'")
    assert.ok(dirsAt > 0, '没找到 dirs 分支')
    const guardAt = src.indexOf('if (entries.length)', dirsAt)
    assert.ok(guardAt > dirsAt, 'dirs 分支里必须有 if (entries.length) 守卫')
    // 只切到该 if 块的收尾，后面的兜底不该包含进来
    const open = src.indexOf('{', guardAt)
    const close = src.indexOf('\n      }', open)
    assert.ok(close > open, '没找到 if 块的收尾')
    const block = src.slice(open, close)
    assert.match(
      block,
      /await handleEntries\(entries\)/,
      'if 块里要真的处理条目'
    )
    assert.match(
      block,
      /\breturn\b/,
      '处理完必须 return —— 否则继续读 dataTransfer.files 并把同一批文件再传一遍'
    )
  })

  test('dirs 分支：实体化失败要有 .files 兜底，而不是静默结束', () => {
    const src = codeOnly(read(DND))
    const dirsAt = src.indexOf("mode === 'dirs'")
    const filesAt = src.indexOf('event.dataTransfer?.files', dirsAt)
    assert.ok(filesAt > dirsAt, 'dirs 分支之后必须有读 .files 的兜底')
    // 兜底不只是「存在」，还得真的被用上
    const flsAt = src.indexOf('if (fls.length > 0)', filesAt)
    assert.ok(flsAt > filesAt, '读到 .files 之后要真的用')
  })

  test('dragCounter 在分类之前就归零（不能等实体化完才重置）', () => {
    // 实体化是 await 的。dragenter 期间用户如果移动鼠标，会再触发 dragenter，
    // 于是高亮状态会二次进入。归零放在最前面才不会漏。
    const src = codeOnly(read(DND))
    const handlerAt = src.indexOf('const handleDrop')
    const body = src.slice(handlerAt, src.indexOf('const handleFileSelect', handlerAt))
    const resetAt = body.indexOf('dragCounter.value = 0')
    const classifyAt = body.indexOf('classifyDrop')
    assert.ok(resetAt >= 0 && classifyAt >= 0)
    assert.ok(resetAt < classifyAt, '先归零，再做任何 await 之前')
  })
})