// 重名消解（server/utils/naming.ts）—— 跑真函数 + 真 sqlite。
//
// ## 为什么这份测试值钱
//
// 这套算法在本项目里曾经存在**三份**实现，并且已经开始分叉：
//
//   file.ts            `${base} (${nextN})${ext}`
//   folders.ts         `${base} (${nextN})`
//   save.post.ts       buildName(): n <= 1 ? 无括号 : 有括号
//
// 三份的「怎么判冲突」「怎么找最大 n」「怎么转义」都一样，所以合并它们省下的是
// 一份「三处必须同步改」的隐患。而它又是**用户可见**的行为：用户上传两份同名
// 文件，看到的名字必须对得上。
//
// 所以这里既测纯函数 dedupeName，也测跑在真 sqlite 上的 resolveUniqueName ——
// 命名对不对取决于 SQL 查回来的集合和正则扫出来的集合能不能对上，那部分只有
// 真库能验。
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { openRawDb } = await import('./helpers/sqlite-fixture.mjs')
const { openAdapterDb } = await import('./helpers/adapter-db.mjs')

const { dedupeName, resolveUniqueName, FILE_NAMES, FOLDER_NAMES } =
  await import('../server/utils/naming.ts')

describe('dedupeName', () => {
  test('n = 1 就是原名，不加括号', () => {
    // 这是与 save.post.ts 旧 buildName 对齐的关键：1 不是「第 1 个副本」
    assert.equal(dedupeName('报告', '.txt', 1), '报告.txt')
  })

  test('n >= 2 加括号', () => {
    assert.equal(dedupeName('报告', '.txt', 2), '报告 (2).txt')
    assert.equal(dedupeName('报告', '.txt', 10), '报告 (10).txt')
    assert.equal(dedupeName('report', '', 3), 'report (3)')
  })

  test('n = 0 与负数也当原名', () => {
    assert.equal(dedupeName('a', '.txt', 0), 'a.txt')
    assert.equal(dedupeName('a', '.txt', -1), 'a.txt')
  })

  test('ext 为空时就是纯目录名', () => {
    assert.equal(dedupeName('照片', '', 2), '照片 (2)')
  })

  test('ext 本身含括号或点号时原样拼', () => {
    assert.equal(dedupeName('v1.2', '.tar.gz', 2), 'v1.2 (2).tar.gz')
    assert.equal(dedupeName('a(b)', '.txt', 2), 'a(b) (2).txt')
  })
})

// ## 有四条变异测不出效果，而且**应该**测不出
//
// 变异扫描跑了 20 条，16 条被抓。剩下 4 条经实测确认是等价变异，不是覆盖
// 缺口，记在这里免得后人以为是漏了：
//
//   1-2. LIKE 模式改**松**（`base (%)` → `%base%`、`base (%)` → `base%`）
//        真库实测：三种模式对 `a.txt` 算出的 nextN 都是 4。原因是 LIKE 只是
//        **预筛**，真正的过滤器是那个带锚点的正则 `^base \((\d+)\)ext$` ——
//        多捞回来的名字正则一律不认，maxN 不变。
//   3.   正则末尾去掉 `$`。走不到：ESCAPE 正常时 LIKE 只返回恰好 `base (n)ext`
//        形状的行，正则匹配的一定是整串。它是纵深防御，不是承重结构。
//   4.   `if (existing.size === 0)` 提前返回。集合为空 ⟺ `!has(desired)`，
//        与原分支同一件事。
//
// 反过来，LIKE 模式改**紧**是真 bug（丢 ext 段就查不到 `a (2).txt`，
// nextN 会算成 2，返回一个已被占用的名字，上传直接撞唯一约束）。
// 那两条有专门的测试盯着。
describe('resolveUniqueName（真 sqlite）', () => {
  let raw
  let db

  before(async () => {
    raw = await openRawDb()
    // 表结构照 schema.sql 的最小子集，只保留这两处查询用到的列
    await raw.run(`CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      folder_id INTEGER,
      filename TEXT NOT NULL
    )`)
    await raw.run(`CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      parent_id INTEGER,
      name TEXT NOT NULL
    )`)
    db = openAdapterDb(raw.raw)
  })

  after(async () => {
    await raw?.close()
  })

  const addFile = (name, userId = 1, folderId = null) =>
    raw.run('INSERT INTO files (user_id, folder_id, filename) VALUES (?, ?, ?)',
      [userId, folderId, name])

  const addFolder = (name, userId = 1, parentId = null) =>
    raw.run('INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)',
      [userId, parentId, name])

  const clear = async () => {
    await raw.run('DELETE FROM files')
    await raw.run('DELETE FROM folders')
  }

  const uniqueFile = (desired, userId = 1, folderId = null) =>
    resolveUniqueName(db, FILE_NAMES, userId, folderId, desired, true)

  const uniqueFolder = (desired, userId = 1, parentId = null) =>
    resolveUniqueName(db, FOLDER_NAMES, userId, parentId, desired, false)

  test('空目录：原名直接可用', async () => {
    await clear()
    const r = await uniqueFile('a.txt')
    assert.equal(r.name, 'a.txt')
    assert.equal(r.nextN, 1)
    assert.equal(r.base, 'a')
    assert.equal(r.ext, '.txt')
  })

  test('原名已存在 → (2)', async () => {
    await clear()
    await addFile('a.txt')
    const r = await uniqueFile('a.txt')
    assert.equal(r.name, 'a (2).txt')
    assert.equal(r.nextN, 2)
  })

  test('只有原名、没有 (n) 时从 2 开始', async () => {
    await clear()
    await addFile('a.txt')
    assert.equal((await uniqueFile('a.txt')).name, 'a (2).txt')
  })

  test('已有 (2) → (3)', async () => {
    await clear()
    await addFile('a.txt')
    await addFile('a (2).txt')
    assert.equal((await uniqueFile('a.txt')).name, 'a (3).txt')
  })

  test('跳过空洞取最大 + 1，不填补', async () => {
    // 有 2 和 5 就没有 4 —— 那不是我们建的，填进去可能与别人的意图冲突
    await clear()
    await addFile('a.txt')
    await addFile('a (2).txt')
    await addFile('a (5).txt')
    const r = await uniqueFile('a.txt')
    assert.equal(r.nextN, 6)
    assert.equal(r.name, 'a (6).txt')
  })

  test('同扩展名的多个文件互不干扰', async () => {
    await clear()
    await addFile('a.txt')
    await addFile('a.md')
    assert.equal((await uniqueFile('a.txt')).name, 'a (2).txt')
    assert.equal((await uniqueFile('a.md')).name, 'a (2).md', '各自算各自的')
  })

  test('别的目录里的同名不算冲突', async () => {
    await clear()
    await addFile('a.txt', 1, 100)
    assert.equal((await uniqueFile('a.txt', 1, 200)).name, 'a.txt', '换个目录就该能用')
    assert.equal((await uniqueFile('a.txt', 1, null)).name, 'a.txt', '根层也算另一个格子')
  })

  test('别的用户的同名不算冲突', async () => {
    await clear()
    await addFile('a.txt', 1)
    assert.equal((await uniqueFile('a.txt', 2)).name, 'a.txt')
  })

  test('目录名不拆扩展名', async () => {
    await clear()
    await addFolder('v1.2 备份')
    const r = await uniqueFolder('v1.2 备份')
    assert.equal(r.name, 'v1.2 备份 (2)', '不该出现 v1 (2).2 备份')
    assert.equal(r.base, 'v1.2 备份')
    assert.equal(r.ext, '', '目录的 ext 应为空')
  })

  test('目录重名递增', async () => {
    await clear()
    await addFolder('照片')
    await addFolder('照片 (2)')
    assert.equal((await uniqueFolder('照片')).name, '照片 (3)')
  })

  test('文件名的点号文件名（.gitignore）不拆', async () => {
    await clear()
    const r = await uniqueFile('.gitignore')
    // 点在开头 → 不拆，于是副本是 .gitignore (2)
    assert.equal(r.base, '.gitignore')
    assert.equal(r.ext, '')
    await addFile('.gitignore')
    assert.equal((await uniqueFile('.gitignore')).name, '.gitignore (2)')
  })

  test('无扩展名的文件名不拆', async () => {
    await clear()
    const r = await uniqueFile('README')
    assert.equal(r.base, 'README')
    assert.equal(r.ext, '')
    await addFile('README')
    assert.equal((await uniqueFile('README')).name, 'README (2)')
  })

  test('名字里含 % 或 _ 时只匹配自己', async () => {
    // 转义 + ESCAPE 配对。不配对的话搜 a_b 会把 aXb 也算成「已存在」，
    // 于是 a_b 会被误判成需要改名。
    await clear()
    await addFile('aXb.txt')
    await addFile('c_d.txt')
    const r1 = await uniqueFile('a_b.txt')
    assert.equal(r1.name, 'a_b.txt', 'a_b 不该被 aXb 挤掉')

    const r2 = await uniqueFile('c_d.txt')
    assert.equal(r2.name, 'c_d (2).txt', 'c_d 确实存在，该改名')
  })

  // 上面两条区分不出「有没有 ESCAPE」。原因是：漏了 ESCAPE 时反斜杠变成普通
  // 字符，模式 `a\_b (%)` 反而**匹配不到** 'a_b (2).txt' —— 结果是查不到行、
  // 判定「原名可用」，而那个原名其实已经被 (2) 的存在暗示着占用了。
  //
  // 所以判据必须是：**存在同名的 (n) 时必须接着往后排**。这才是 ESCAPE 的作用
  // 点，也是唯一能测出「声明了 ESCAPE」的行为差异。
  test('名字含下划线且已有 (n) 时接着往后排（ESCAPE 声明的判据）', async () => {
    await clear()
    await addFile('a_b.txt')
    await addFile('a_b (2).txt')
    const r = await uniqueFile('a_b.txt')
    assert.equal(r.name, 'a_b (3).txt',
      '漏了 ESCAPE 会查不到 a_b (2).txt，于是返回已被占用的 a_b.txt')
  })

  test('名字含百分号且已有 (n) 时接着往后排', async () => {
    await clear()
    await addFile('50%.txt')
    await addFile('50% (2).txt')
    assert.equal((await uniqueFile('50%.txt')).name, '50% (3).txt')
  })

  test('目录名含下划线时同样', async () => {
    await clear()
    await addFolder('my_dir')
    await addFolder('my_dir (2)')
    assert.equal((await uniqueFolder('my_dir')).name, 'my_dir (3)')
  })

  test('子目录（非根层）查询也一样', async () => {
    // 上面几条都走根层分支；非根层是另一段模板，必须单独验
    await clear()
    await addFile('a_b.txt', 1, 100)
    await addFile('a_b (2).txt', 1, 100)
    const r = await uniqueFile('a_b.txt', 1, 100)
    assert.equal(r.name, 'a_b (3).txt')
  })

  test('名字里含括号时正则不误判', async () => {
    await clear()
    await addFile('v(1).txt')
    const r = await uniqueFile('v(1).txt')
    assert.equal(r.name, 'v(1) (2).txt')
    await addFile('v(1) (2).txt')
    assert.equal((await uniqueFile('v(1).txt')).name, 'v(1) (3).txt')
  })

  test('已有的 (n) 被打乱顺序也不影响', async () => {
    await clear()
    await addFile('a (7).txt')
    await addFile('a (3).txt')
    await addFile('a.txt')
    assert.equal((await uniqueFile('a.txt')).name, 'a (8).txt')
  })

  test('形状像但不匹配的不算已有 (n)', async () => {
    await clear()
    await addFile('a.txt')
    await addFile('a (x).txt')   // 不是数字
    await addFile('a (2) extra.txt') // 后面还有东西
    assert.equal((await uniqueFile('a.txt')).name, 'a (2).txt',
      '只有严格的 base (n)ext 形状才算已占用')
  })

  // 下面两条钉住 LIKE 模式的**形状**。形状松一点就会误判：
  //   `%base%ext`  → 「xa.txt」被当成冲突，a.txt 被迫改名
  //   `base (%)`（少个空格+括号）→ 形状相近但不合法的名字混进来
  // LIKE 模式错得「更松」会让用户莫名其妙收到 (2)；错得「更紧」会让重名文件
  // 撞唯一约束、直接上传失败 —— 后者更糟。
  test('只有恰好 base (n)ext 形状才算冲突（模式不能更松）', async () => {
    await clear()
    // 这些名字**不该**与 'a.txt' 冲突
    await addFile('xa.txt')       // 前缀有东西 → %base% 形式会误伤
    await addFile('aX.txt')       // 同上
    await addFile('a 1.txt')      // 空格+数字但没括号
    await addFile('a (x).txt')    // 括号里不是数字
    assert.equal((await uniqueFile('a.txt')).name, 'a.txt',
      '这些都不该让 a.txt 改名')
  })

  test('只有 (n) 而没有原名时，原名仍可用', async () => {
    // 关键：判冲突是「结果集里有没有 desired」，不是「结果集非空」。
    // 若写成 `if (!existing.size)`，这个场景会返回 'a (3).txt' 而不是 'a.txt'。
    await clear()
    await addFile('a (2).txt')
    await addFile('a (3).txt')
    const r = await uniqueFile('a.txt')
    assert.equal(r.name, 'a.txt', 'a.txt 没被占用，不该因为旁边有 (2)(3) 就改名')
    assert.equal(r.nextN, 1)
  })

  test('目录同样：只有 (n) 时原名可用', async () => {
    await clear()
    await addFolder('照片 (2)')
    const r = await uniqueFolder('照片')
    assert.equal(r.name, '照片')
  })

  test('超过 9 的两位数编号正确', async () => {
    await clear()
    await addFile('a.txt')
    for (let i = 2; i <= 11; i++) await addFile(`a (${i}).txt`)
    assert.equal((await uniqueFile('a.txt')).name, 'a (12).txt')
  })
})
