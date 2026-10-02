// useArchiveTree 的行为（跑真逻辑，不靠源码断言）。
//
// ## 为什么值得单独测
//
// 目录树有两个预览器共用（zip / 7z），而它干的是**安全相关**的活：拒绝绝对
// 路径、盘符、`..` 穿越、NUL 字节。压缩包条目名完全由上传者控制，而这些路径
// 在 7z 那条链上会直接交给引擎的 FS —— 绕过了浏览器沙箱。所以「哪一类路径被
// 挡下了」必须钉死，不能靠读代码确认。
//
// ## 怎么测真逻辑
//
// composable 只依赖 vue 的 ref/computed/shallowRef/triggerRef，都是纯函数式的
// 响应式原语 —— 在 node 里 import 'vue' 直接用即可，不需要 DOM、不需要挂载。
// 之前是抄两份在组件里，所以没得测；现在逻辑只有一份，直接调。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

// vue 的 CJS/ESM 双出口：node --test 下走 default 才是真 API
const vue = await import('vue').then((m) => m.default ?? m)
const { useArchiveTree } = await import('../app/composables/useArchiveTree.ts')

const MAX = 50000

/**
 * 新建一棵树，走一遍真实流程：beginLoad → ingest → endLoad。
 *
 * 刻意和组件里的调用顺序一致，并收尾 endLoad —— 否则树停在 loading 状态，
 * 断言「加载完 loading 为 false」会失败，而那不是实现的错。
 */
function tree(records, opts = {}) {
  const t = useArchiveTree({ rootId: opts.rootId ?? 'test-root', maxEntries: opts.maxEntries ?? MAX })
  t.beginLoad()
  if (records) t.ingest(records, opts.format ?? 'zip')
  t.endLoad()
  return t
}

/** 一个文件条目 */
function file(path, extra = {}) {
  return {
    path,
    directory: false,
    fileSize: 100,
    compressedSize: 50,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    encrypted: false,
    read: async () => new Blob(['x']),
    ...extra
  }
}

/** 一个目录条目 */
function dir(path, extra = {}) {
  return { ...file(path, { directory: true, fileSize: 0, compressedSize: 0 }), ...extra }
}

describe('路径规范化：危险路径必须被拒绝', () => {
  // 这批是真正的攻击面。normalizePath 返回 null 时该条目被计入 skippedCount
  // 并丢弃，绝不进树。
  const dangerous = [
    ['绝对路径', '/etc/passwd'],
    ['Windows 盘符', 'C:/Windows/system32'],
    ['小写盘符', 'c:\\windows'],
    ['父目录穿越', '../outside.txt'],
    ['中间穿越', 'a/../../b.txt'],
    ['当前目录穿越', 'a/./../../b'],
    ['NUL 字节', 'a\u0000b.txt'],
    ['只有斜杠', '/'],
    ['空字符串', '']
  ]

  for (const [name, path] of dangerous) {
    test(`拒绝 ${name}: ${JSON.stringify(path)}`, () => {
      const t = tree([file(path)])
      assert.equal(t.skippedCount.value, 1, `${path} 没被计入 skipped`)
      assert.equal(t.visibleFiles.value.length, 0, `${path} 竟然进了文件列表`)
      assert.equal(t.totalCount.value, 1, 'totalCount 应仍计入原始条目数')
    })
  }

  // 注意 visibleFiles 是**当前目录**的文件，不是整棵树。所以根层只看到平铺的
  // 那两个，另外四个分别落在 dir / deep/nested/path / trailing 下面。
  // （第一版这里断言「根层 6 个文件」直接红了 —— 断言写错，不是实现错。
  //   实测：根层 files=2、dirs=3，总条目 6。）
  test('安全路径正常通过，一个都不该被跳过', () => {
    const t = tree([
      file('a.txt'),
      file('dir/b.txt'),
      file('deep/nested/path/c.txt'),
      file('./d.txt'),
      file('dir//e.txt'),
      file('trailing/f.txt')
    ])
    assert.equal(t.skippedCount.value, 0, '6 条安全路径不该有任何一条被跳过')
    assert.equal(t.totalCount.value, 6)
    // 根层：a.txt 与 ./d.txt 平铺，其余 4 条各自造出目录
    assert.equal(t.visibleFiles.value.length, 2, '根层应只有 2 个平铺文件')
    assert.deepEqual(
      t.visibleFiles.value.map((f) => f.filename).sort(),
      ['a.txt', 'd.txt'],
      'dir//e.txt 的重复斜杠应被规范化掉，仍落在 dir 下'
    )
    assert.equal(t.visibleFolders.value.length, 3, '根层应看到 dir / deep / trailing')
    assert.deepEqual(
      t.visibleFolders.value.map((f) => f.name).sort(),
      ['deep', 'dir', 'trailing']
    )
    // dir 下两个文件（含双斜杠那个）
    t.goToPath('dir')
    assert.equal(t.visibleFiles.value.length, 2, 'dir 下应有 b.txt 与 e.txt')
  })

  test('深层路径逐级建目录', () => {
    const t = tree([file('deep/nested/path/c.txt')])
    t.goToPath('deep')
    assert.equal(t.visibleFolders.value.length, 1)
    assert.equal(t.visibleFolders.value[0].name, 'nested')
    t.goToPath('deep/nested/path')
    assert.equal(t.visibleFiles.value[0].filename, 'c.txt')
  })

  test('穿越路径即使伪装成目录也被拒', () => {
    // directory: true 不该绕过检查 —— 目录名同样会进 FS
    const t = tree([dir('../evil')])
    assert.equal(t.skippedCount.value, 1)
    assert.equal(t.root.value.children.length, 0, '穿越目录竟被建出来了')
  })
})

describe('树构建', () => {
  test('多层路径自动补齐缺失的中间目录', () => {
    const t = tree([file('a/b/c/deep.txt')])
    const root = t.root.value
    assert.equal(root.children.length, 1)
    const a = root.children[0]
    assert.equal(a.name, 'a')
    assert.equal(a.children.length, 1)
    const b = a.children[0]
    assert.equal(b.name, 'b')
    assert.equal(b.children.length, 1)
    const c = b.children[0]
    assert.equal(c.name, 'c')
    assert.equal(c.files.length, 1)
    assert.equal(c.files[0].filename, 'deep.txt')
  })

  test('同目录下的多个文件聚到同一个父目录', () => {
    const t = tree([file('dir/one.txt'), file('dir/two.txt'), file('dir/three.txt')])
    const dirNode = t.root.value.children[0]
    assert.equal(dirNode.files.length, 3)
    assert.equal(dirNode.children.length, 0)
  })

  test('目录条目本身建立目录节点', () => {
    const t = tree([dir('empty-dir'), file('empty-dir/inside.txt')])
    const node = t.root.value.children[0]
    assert.equal(node.name, 'empty-dir')
    assert.equal(node.files.length, 1, '目录条目 + 内部文件应共存')
  })

  test('同名不同路径不冲突（按 path 而非 name 建 key）', () => {
    const t = tree([file('a/same.txt'), file('b/same.txt')])
    assert.equal(t.root.value.children.length, 2, '应有两个顶层目录')
    assert.equal(t.root.value.children[0].files[0].filename, 'same.txt')
    assert.equal(t.root.value.children[1].files[0].filename, 'same.txt')
  })

  test('createdAt 先到先得，后来者不覆盖', () => {
    const t = tree([
      dir('d', { modifiedAt: '2026-01-01T00:00:00.000Z' }),
      file('d/f.txt', { modifiedAt: '2027-06-06T00:00:00.000Z' })
    ])
    // ensureDirectory 的既有行为：已存在且已有时间就不再改
    assert.equal(t.root.value.children[0].createdAt, '2026-01-01T00:00:00.000Z')
  })

  test('目录没有时间、子目录有：子目录的时间会被补上', () => {
    const t = tree([file('d/sub/f.txt', { modifiedAt: '2026-05-05T00:00:00.000Z' })])
    // 中间层由 ensureDirectory 用同一个 createdAt 建出来
    assert.equal(t.root.value.children[0].createdAt, '2026-05-05T00:00:00.000Z')
  })

  test('排序：目录在前，各按名字不区分大小写', () => {
    const t = tree([file('Zeta.txt'), file('alpha.txt'), file('Beta.txt'), dir('mid')])
    const root = t.root.value
    assert.equal(root.children[0].name, 'mid', '目录应排在文件之前')
    const names = root.files.map((f) => f.filename)
    assert.deepEqual(names, ['alpha.txt', 'Beta.txt', 'Zeta.txt'])
  })

  test('递归排序：深层目录里的文件也排好了', () => {
    const t = tree([file('a/z.txt'), file('a/b.txt'), file('a/m.txt')])
    const a = t.root.value.children[0]
    assert.deepEqual(a.files.map((f) => f.filename), ['b.txt', 'm.txt', 'z.txt'])
  })
})

describe('条目上限', () => {
  test('超出上限的计入 skippedCount，总数仍是原始数', () => {
    const records = []
    for (let i = 0; i < 10; i++) records.push(file(`f${i}.txt`))
    const t = tree(records, { maxEntries: 4 })
    assert.equal(t.totalCount.value, 10, 'totalCount 是原始条目数')
    assert.equal(t.skippedCount.value, 6, 'skipped 是被截掉的')
    assert.equal(t.visibleFiles.value.length, 4, '只应建 4 个')
  })

  test('上限内的多余条目不计入 skipped', () => {
    const records = []
    for (let i = 0; i < 3; i++) records.push(file(`f${i}.txt`))
    const t = tree(records, { maxEntries: 10 })
    assert.equal(t.skippedCount.value, 0)
    assert.equal(t.totalCount.value, 3)
  })

  // skippedCount 同时承担两件事：超出上限的条目数，以及被 normalizePath 拒掉的
  // 条目数。第一版这条断言写成「3 条进处理、其中 2 条不安全」—— 那是我算错了：
  // maxEntries=3 截掉的是**第 4 条** /abs.txt，它根本没进处理，所以被拒的只有
  // ../bad.txt 一条。实测 skipped=2（1 条超限 + 1 条不安全），visibleFiles=2。
  test('上限截断与路径不安全都计入 skipped', () => {
    const records = [file('a.txt'), file('../bad.txt'), file('b.txt'), file('/abs.txt')]
    const t = tree(records, { maxEntries: 3 })
    assert.equal(t.totalCount.value, 4, 'totalCount 是原始条目数')
    assert.equal(t.skippedCount.value, 2, '1 条超上限 + 1 条路径不安全')
    assert.equal(t.visibleFiles.value.length, 2, 'a.txt 与 b.txt 留下')
  })

  test('超上限的条目即使路径安全也不会被处理', () => {
    // 与上一条对照：这条被上限挡下的路径是安全的，说明 skipped 里确实混着两种原因
    const records = [file('ok1.txt'), file('ok2.txt'), file('cut.txt')]
    const t = tree(records, { maxEntries: 2 })
    assert.equal(t.skippedCount.value, 1)
    assert.equal(t.visibleFiles.value.length, 2)
    assert.ok(!t.root.value.files.some((f) => f.filename === 'cut.txt'))
  })
})

describe('导航与面包屑', () => {
  test('面包屑从根累积到当前路径', () => {
    const t = tree([file('a/b/c.txt')])
    assert.deepEqual(t.breadcrumbs.value, [{ name: '压缩包根目录', path: '' }])
    t.goToPath('a/b')
    assert.deepEqual(t.breadcrumbs.value, [
      { name: '压缩包根目录', path: '' },
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' }
    ])
  })

  test('goToPath 忽略不存在的路径', () => {
    const t = tree([file('a/b.txt')])
    t.goToPath('nope')
    assert.equal(t.currentPath.value, '', '不存在的路径不该改变当前位置')
    t.goToPath('a')
    assert.equal(t.currentPath.value, 'a')
  })

  test('navigateFolder 从 FileList 的 id 还原路径', () => {
    const t = tree([file('x/y/z.txt')])
    // FileList 拿到的是 folder:<path> 形式的 id
    t.navigateFolder({ id: 'folder:x/y', name: 'y' })
    assert.equal(t.currentPath.value, 'x/y')
  })

  test('进入子目录后只看到该目录的内容', () => {
    const t = tree([file('top.txt'), file('sub/inner.txt')])
    // 根层：top.txt 平铺，sub 是目录 —— 所以是 1 个文件 + 1 个目录，不是 2 个文件
    assert.equal(t.visibleFiles.value.length, 1, '根层只有 top.txt')
    assert.equal(t.visibleFolders.value.length, 1, 'sub 作为目录出现')
    t.goToPath('sub')
    assert.equal(t.visibleFiles.value.length, 1)
    assert.equal(t.visibleFiles.value[0].filename, 'inner.txt')
  })

  test('findFile 返回原始条目（含 read）', async () => {
    const t = tree([file('a/b.txt')])
    const row = { id: 'entry:0', filename: 'b.txt', fileSize: 100 }
    const item = t.findFile(row)
    assert.ok(item, 'findFile 应找到条目')
    assert.equal(item.filename, 'b.txt')
    assert.equal(typeof item.read, 'function')
    const blob = await item.read()
    assert.ok(blob instanceof Blob)
  })

  test('findFile 对不存在的 id 返回 undefined', () => {
    const t = tree([file('a.txt')])
    assert.equal(t.findFile({ id: 'entry:999', filename: 'x' }), undefined)
  })
})

describe('搜索过滤', () => {
  test('只过滤当前目录，不递归搜子目录', () => {
    const t = tree([file('apple.txt'), file('sub/banana.txt')])
    t.search.value = 'banana'
    assert.equal(t.visibleFiles.value.length, 0, '子目录里的不该出现在根层搜索结果')
    t.goToPath('sub')
    assert.equal(t.visibleFiles.value.length, 1)
  })

  // 三条分别钉住三个不同的环节：query 转小写、两侧都转小写、includes 真做了。
  // 只写「搜 report 能找到 Report.TXT」一条的话，把 toLocaleLowerCase 从**一侧**
  // 去掉仍然能过（因为另一侧转了就已经匹配不上……不对，另一侧不转就匹配不上）。
  // 所以三条都在，才能把「两侧都转」这件事钉死。
  test('大小写不敏感：文件', () => {
    const t = tree([file('Report.TXT'), file('other.txt')])
    t.search.value = 'report'
    assert.deepEqual(t.visibleFiles.value.map((f) => f.filename), ['Report.TXT'])
    t.search.value = 'REPORT'
    assert.equal(t.visibleFiles.value.length, 1, '全大写也应命中')
  })

  test('大小写不敏感：目录', () => {
    const t = tree([file('Docs/readme.md'), file('IMAGES/x.png')])
    t.search.value = 'docs'
    assert.deepEqual(t.visibleFolders.value.map((f) => f.name), ['Docs'], '小写查询命中大写目录')
    t.search.value = 'DOCS'
    assert.equal(t.visibleFolders.value.length, 1)
  })

  test('大小写不敏感：中文文件名', () => {
    // toLocaleLowerCase 对中文是恒等，但这条确认调用没被写成 toUpperCase 之类
    const t = tree([file('报告.txt')])
    t.search.value = '报告'
    assert.equal(t.visibleFiles.value.length, 1)
  })

  test('搜索只匹配包含关系，不是前缀', () => {
    const t = tree([file('prefix-middle-suffix.txt')])
    t.search.value = 'middle'
    assert.equal(t.visibleFiles.value.length, 1, '中间命中也算')
    t.search.value = 'prefix'
    assert.equal(t.visibleFiles.value.length, 1)
    t.search.value = 'suffix'
    assert.equal(t.visibleFiles.value.length, 1)
    t.search.value = 'nomatch'
    assert.equal(t.visibleFiles.value.length, 0)
  })

  test('搜不到时不返回空数组之外的怪东西', () => {
    const t = tree([file('a.txt')])
    t.search.value = 'zzz'
    assert.deepEqual(t.visibleFiles.value, [])
    assert.deepEqual(t.visibleFolders.value, [])
    assert.equal(t.visibleCount.value, 0)
    // 树本身没被破坏 —— 清掉搜索就该恢复
    t.search.value = ''
    assert.equal(t.visibleFiles.value.length, 1, '清空搜索后应恢复，不该被搜索写坏')
  })

  test('同时过滤目录名与文件名', () => {
    const t = tree([file('docs/a.txt'), file('images/b.png'), dir('docs-archive')])
    // 根层布局：docs/ 与 images/ 两个目录 + docs-archive。没有平铺文件 ——
    // 第一版这里断言「1 个文件」直接红了，是我把子目录里的文件当成了根层的。
    assert.equal(t.visibleFiles.value.length, 0, '根层本就没有平铺文件')
    assert.equal(t.visibleFolders.value.length, 3)

    t.search.value = 'docs'
    // 目录 docs 与 docs-archive 都命中；images 不命中。文件仍是 0（根层没有）
    assert.deepEqual(
      t.visibleFolders.value.map((f) => f.name).sort(),
      ['docs', 'docs-archive'],
      'docs 与 docs-archive 都该命中，images 不该'
    )
    assert.equal(t.visibleFiles.value.length, 0)

    // 进了 docs 之后，搜到的 a.txt 才出现 —— 过滤只作用于当前目录
    t.goToPath('docs')
    t.search.value = 'a'
    assert.equal(t.visibleFiles.value.length, 1)
    assert.equal(t.visibleFiles.value[0].filename, 'a.txt')
  })

  test('清空搜索恢复全部', () => {
    const t = tree([file('a.txt'), file('b.txt')])
    t.search.value = 'a'
    assert.equal(t.visibleFiles.value.length, 1)
    t.search.value = '  '
    assert.equal(t.visibleFiles.value.length, 2, '纯空白视作无搜索')
  })

  test('visibleCount 随搜索变化', () => {
    const t = tree([file('a.txt'), file('b.txt'), file('c.txt')])
    assert.equal(t.visibleCount.value, 3)
    t.search.value = 'a'
    assert.equal(t.visibleCount.value, 1)
  })
})

describe('条目字段映射', () => {
  test('ArchiveFileItem 字段完整，format 来自调用方', () => {
    const t = tree([file('a/b.txt', { encrypted: true, compressedSize: 42 })], { format: '7z' })
    const item = t.findFile({ id: 'entry:0', filename: 'b.txt', fileSize: 100 })
    assert.equal(item.format, '7z', 'format 应由 ingest 的参数决定，不能被共用层写死')
    assert.equal(item.encrypted, true)
    assert.equal(item.compressedSize, 42)
    assert.equal(item.path, 'a/b.txt')
    assert.equal(item.filename, 'b.txt')
    assert.equal(item.modifiedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(item.id, item.key, 'id 与 key 同值（FileList 按 id 查）')
  })

  test('负数与非数字大小被夹到 0', () => {
    const t = tree([
      file('neg.txt', { fileSize: -5, compressedSize: -1 }),
      file('nan.txt', { fileSize: Number.NaN, compressedSize: 'abc' })
    ])
    const sizes = t.root.value.files.map((f) => f.fileSize)
    assert.deepEqual(sizes, [0, 0], '不该把负数或 NaN 传给 FileList')
  })

  // 这两条断言映射出来的**字段集合**，防的是「顺手把 path / read / encrypted
  // 也塞进行里」—— 那些字段 FileList 用不到，而 read 是闭包，塞进去会让每次
  // 渲染都带上整个引擎会话。
  test('映射给 FileList 的行只含列表要的字段', () => {
    // 放进一个子目录，才能在当前层看到行
    const t = tree([file('a/b.txt')])
    t.goToPath('a')
    const row = t.visibleFiles.value[0]
    assert.deepEqual(Object.keys(row).sort(), ['contentType', 'createdAt', 'fileSize', 'filename', 'id'])
    assert.equal(row.contentType, '', '压缩包内条目没有 MIME，留空')
    assert.equal(row.createdAt, '2026-01-01T00:00:00.000Z')
    assert.equal(row.fileSize, 100)
  })

  test('目录行只含 id/name/createdAt', () => {
    const t = tree([dir('d')])
    const row = t.visibleFolders.value[0]
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'name'])
    assert.equal(row.id, 'folder:d')
    assert.equal(row.name, 'd')
    assert.equal(row.createdAt, '2026-01-01T00:00:00.000Z')
  })

  // createdAt 的 `|| null` 兜底：FileList 的 createdAt 类型是 `string | null`，
  // 传 undefined 会让它的日期格式化走到「显示 undefined」那条分支。变异扫描
  // 里「去掉 || null」这条一开始没被抓到，就是因为只有目录行那一条覆盖到，
  // 而它验的是目录不是文件 —— 文件行走的是另一处代码。
  test('文件行没有时间时兜成 null', () => {
    const t = tree([file('nodate.txt', { modifiedAt: '' })])
    const row = t.visibleFiles.value[0]
    assert.equal(row.createdAt, null, '空字符串应变 null')
    assert.ok(!('createdAt' in row) || row.createdAt === null)
  })

  test('目录行没有时间时兜成 null', () => {
    const t = tree([dir('nodate', { modifiedAt: '' })])
    assert.equal(t.visibleFolders.value[0].createdAt, null)
  })

  test('嵌套在目录里的文件行同样兜 null', () => {
    const t = tree([file('sub/nodate.txt', { modifiedAt: '' })])
    t.goToPath('sub')
    assert.equal(t.visibleFiles.value[0].createdAt, null)
  })

  test('有正常时间时原样透传', () => {
    const t = tree([file('ok.txt', { modifiedAt: '2026-03-04T05:06:07.000Z' })])
    assert.equal(t.visibleFiles.value[0].createdAt, '2026-03-04T05:06:07.000Z')
  })
})

describe('加载状态与失败处理', () => {
  test('beginLoad 置 loading 并清空上一棵树', () => {
    const t = tree([file('old.txt')])
    assert.equal(t.loading.value, false)
    t.search.value = 'old'
    t.beginLoad()
    assert.equal(t.loading.value, true, 'beginLoad 应置 loading')
    assert.equal(t.search.value, '', '应重置搜索')
    assert.equal(t.currentPath.value, '')
    assert.equal(t.totalCount.value, 0)
    assert.equal(t.skippedCount.value, 0)
    assert.equal(t.error.value, '')
    assert.equal(t.root.value.files.length, 0, '旧树应被清空')
    assert.equal(t.root.value.children.length, 0)
    t.endLoad()
    assert.equal(t.loading.value, false)
  })

  test('beginLoad 清掉上一次的错误信息', () => {
    const t = tree([file('a.txt')])
    t.failTree('坏了')
    assert.equal(t.error.value, '坏了')
    t.beginLoad()
    assert.equal(t.error.value, '', '重新加载时不该留着旧错误')
  })

  test('failTree 落到空树并记下消息', () => {
    const t = tree([file('a.txt'), file('b.txt')])
    assert.equal(t.root.value.files.length, 2)
    t.failTree('无法读取压缩包内容')
    assert.equal(t.error.value, '无法读取压缩包内容')
    assert.equal(t.root.value.files.length, 0, '失败后不该留着半棵残树')
    assert.equal(t.root.value.children.length, 0)
  })

  test('失败后 visibleCount 归零，界面上只剩错误提示', () => {
    const t = tree([file('a.txt')])
    t.failTree('boom')
    assert.equal(t.visibleCount.value, 0)
  })

  // 注意 ingest 本身**不清空** —— 清空是 beginLoad 的职责（组件里 load() 先
  // beginLoad 再 ingest）。所以直接连续两次 ingest 是会累积的，2 !== 1。
  // 真实代码里不会出现这种调用（换包时一定先 beginLoad），但把它钉下来，
  // 免得将来有人以为 ingest 自带重置。
  test('ingest 不自带清空：连续两次会累积', () => {
    const t = tree([file('first.txt')])
    t.ingest([file('second.txt')], 'zip')
    assert.equal(t.root.value.files.length, 2, 'ingest 不清空，清空是 beginLoad 的活')
  })

  test('重新加载（beginLoad + ingest）替换掉上一批', () => {
    const t = tree([file('first.txt')])
    t.beginLoad()
    t.ingest([file('second.txt')], 'zip')
    assert.equal(t.root.value.files.length, 1, 'beginLoad 清过，不该累积')
    assert.equal(t.root.value.files[0].filename, 'second.txt')
    assert.deepEqual(
      t.root.value.files.map((f) => f.filename),
      ['second.txt'],
      '不该残留 first.txt'
    )
  })

  test('beginLoad 会丢掉旧的 directoryLookup 条目', () => {
    const t = tree([file('old/deep/file.txt')])
    t.beginLoad()
    // 旧路径 'old/deep' 不该还能导航过去
    t.goToPath('old/deep')
    assert.equal(t.currentPath.value, '', '换包后旧路径不该再可达')
  })

  // lookup 里必须有一个 '' → root 的登记，否则根目录取不到（见下面这条）。
  // 少了它，currentDirectory 会靠 `|| tree` 兜底 —— 单看根目录仍然「能显示」，
  // 所以这条要靠 goToPath('') 之后的状态来判断，而不是靠根目录能不能看到。
  test('beginLoad 把新 root 登记为根路径，根目录可达', () => {
    const t = tree([file('x.txt')])
    t.beginLoad()
    t.ingest([file('y.txt')], 'zip')
    t.goToPath('')
    assert.equal(t.currentPath.value, '', '根路径始终可达')
    assert.equal(t.visibleFiles.value.length, 1)
    assert.equal(t.visibleFiles.value[0].filename, 'y.txt')
  })

  test('beginLoad 后根目录能看到新内容（lookup 与 root 指向同一个树）', () => {
    const t = tree([file('old.txt')])
    t.beginLoad()
    // 不 ingest：树是空的。visibleFiles 若还非空，说明 lookup 仍指着旧 root
    assert.equal(t.visibleFiles.value.length, 0, 'beginLoad 后不该还看得见旧内容')
    assert.equal(t.visibleFolders.value.length, 0)
  })

  test('导航进子目录再回根，root 内容一致', () => {
    const t = tree([file('sub/inner.txt')])
    t.goToPath('sub')
    assert.equal(t.visibleFiles.value.length, 1)
    t.goToPath('')
    assert.equal(t.visibleFiles.value.length, 0, '根层没有平铺文件')
    assert.equal(t.visibleFolders.value.length, 1, '根层应看到 sub 目录')
  })
})

describe('两个 rootId 不冲突', () => {
  test('rootId 各异时根节点 id 不同', () => {
    const a = tree([file('x.txt')], { rootId: 'zip-root' })
    const b = tree([file('x.txt')], { rootId: 'sevenzip-root' })
    assert.equal(a.root.value.id, 'zip-root')
    assert.equal(b.root.value.id, 'sevenzip-root')
  })

  test('子目录 id 只依赖 path，与 rootId 无关', () => {
    const a = tree([file('p/q.txt')], { rootId: 'zip-root' })
    const b = tree([file('p/q.txt')], { rootId: 'sevenzip-root' })
    assert.equal(a.root.value.children[0].id, 'folder:p')
    assert.equal(b.root.value.children[0].id, 'folder:p')
  })
})
