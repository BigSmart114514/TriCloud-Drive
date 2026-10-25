// 新建空白文件：名字校验、桶里那个 0 字节对象、以及它和数据库那一行的先后顺序。
//
// ## 为什么核心逻辑要单独成一个模块
//
// 端点本身（server/api/files/create.post.ts）用 Nuxt 的自动导入，`node --test`
// import 不了 —— 这是本项目既有的天花板。所以业务本体落在
// server/utils/create-empty-file.ts，由端点负责鉴权后调用它。
//
// 测试跑的是**真 sqlite**（内存库）+ 假的存储桶，断的是：
//   - 桶里那个对象什么时候放、放在哪个 key 上
//   - 放失败时数据库里有没有留下幽灵行
//   - 写库失败时有没有把刚放上去的对象清掉
//   - 重名时名字怎么变、会不会为此重新放一个对象
//
// 这几条每条都在「界面上看不出问题、但账对不上」的那一类里，所以值得钉死。
import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

/** 从 `async name(` 起按大括号配平，取出那个方法/函数的正文（含外层花括号） */
function blockOf(src, marker) {
  const at = src.indexOf(marker)
  assert.ok(at > 0, `找不到 ${marker} —— 锚点没了，下面的断言会变成恒真`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${marker} 的花括号没配平`)
}

const { openRawDb } = await import('./helpers/sqlite-fixture.mjs')
const { openAdapterDb } = await import('./helpers/adapter-db.mjs')

const { createEmptyFile, validateNewFileName } = await import('~~/server/utils/create-empty-file')

const OWNER = 77
const OTHER = 88

let raw
let db

/** 与 schema.sql 的 files 表同形，含两条唯一索引 —— 重名重试要靠它们才有意义 */
const FILES_DDL = `CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  folder_id INTEGER,
  filename TEXT NOT NULL,
  file_key TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_url TEXT NOT NULL,
  content_type TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  Shared INTEGER NOT NULL DEFAULT 2,
  IsPublic BOOLEAN NOT NULL DEFAULT 0
)`

before(async () => {
  raw = await openRawDb()
  await raw.run(FILES_DDL)
  await raw.run('CREATE UNIQUE INDEX ux_files_user_folder_filename ON files (user_id, COALESCE(folder_id, -1), filename)')
  await raw.run('CREATE UNIQUE INDEX ux_files_file_key ON files (file_key)')
  db = openAdapterDb(raw.raw)
})

after(async () => {
  await raw?.close()
})

beforeEach(async () => {
  await raw.run('DELETE FROM files')
})

const rows = () => raw.all('SELECT * FROM files ORDER BY id')

/** 假的存储桶。log 按发生顺序记 put / delete，用来断言先后关系 */
function makeDeps(overrides = {}) {
  const log = overrides.log ?? []
  const puts = []
  const deletes = []
  const deps = {
    putEmptyObject: async (key) => {
      log.push('put')
      puts.push(key)
      if (overrides.putThrows) throw new Error('桶挂了')
    },
    deleteObject: async (key) => {
      log.push('delete')
      deletes.push(key)
      if (overrides.deleteThrows) throw new Error('删不掉')
      return true
    },
    objectUrl: (key) => `https://cos.example/${key}`
  }
  return { deps, log, puts, deletes }
}

/**
 * 包一层真 db，用来在 INSERT 上制造失败 / 记录执行顺序。
 *
 * 只拦 `INSERT INTO files`，其余查询原样交给真实适配器 —— 这样
 * resolveUniqueName 跑的仍是真 SQL。
 */
function spyDb(real, options = {}) {
  const { failFirstInsert = null, failEveryInsert = null } = options
  const log = options.log ?? []
  let attempts = 0
  let failedOnce = false

  return {
    log,
    get attempts() { return attempts },
    prepare(sql) {
      if (!/INSERT INTO files/i.test(sql)) return real.prepare(sql)
      const stmt = real.prepare(sql)
      return {
        bind(...args) {
          return {
            first: async () => {
              attempts += 1
              log.push('insert')
              if (failFirstInsert && !failedOnce) {
                failedOnce = true
                throw Object.assign(new Error(failFirstInsert), { code: 'SQLITE_CONSTRAINT' })
              }
              if (failEveryInsert) {
                throw Object.assign(new Error(failEveryInsert), { code: 'SQLITE_CONSTRAINT' })
              }
              return stmt.bind(...args).first()
            },
            all: () => stmt.bind(...args).all(),
            run: () => stmt.bind(...args).run()
          }
        }
      }
    }
  }
}

const FILENAME_UNIQUE = "SQLITE_CONSTRAINT: UNIQUE constraint failed: index 'ux_files_user_folder_filename'"

describe('validateNewFileName', () => {
  test('正常名字原样返回（trim 掉首尾空格）', () => {
    assert.equal(validateNewFileName('  待办.txt  '), '待办.txt')
    assert.equal(validateNewFileName('README'), 'README')
  })

  test('空 / 纯空格 / 非字符串一律 400', () => {
    for (const bad of ['', '   ', undefined, null, 42]) {
      assert.throws(() => validateNewFileName(bad), (e) => e.statusCode === 400, `应拒绝 ${JSON.stringify(bad)}`)
    }
  })

  test('含斜杠一律 400（它会改变 key 的形状）', () => {
    for (const bad of ['a/b.txt', 'a\\b.txt', '../x.txt', '..', '.']) {
      assert.throws(() => validateNewFileName(bad), (e) => e.statusCode === 400, `应拒绝 ${bad}`)
    }
  })

  test('256 字符拒绝，255 字符通过', () => {
    assert.throws(() => validateNewFileName('a'.repeat(256)), (e) => e.statusCode === 400)
    assert.equal(validateNewFileName('a'.repeat(255)).length, 255)
  })
})

describe('createEmptyFile', () => {
  test('先把空对象放进桶，再写库 —— 反了就会签出一条 404 的下载链接', async () => {
    // put 与 insert 记在**同一个**数组里才比得出先后。分成两份日志的话
    // 「put 是第一个」恒成立，等于没测。
    const log = []
    const { deps } = makeDeps({ log })
    const spied = spyDb(db, { log })

    await createEmptyFile(spied, OWNER, null, '待办.txt', deps)

    assert.deepEqual(log, ['put', 'insert'], '必须是先放对象、再写库')
  })

  test('对象 key 用的是属主，形状是 users/<id>/<YYYYMM>/<uuid><ext>', async () => {
    const { deps, puts } = makeDeps()

    await createEmptyFile(db, OWNER, null, '待办.txt', deps)

    assert.equal(puts.length, 1)
    const key = puts[0]
    assert.match(
      key,
      new RegExp(`^users/${OWNER}/\\d{6}/[0-9a-f-]{36}\\.txt$`),
      `key 形状不对（属主必须是 ${OWNER}）：${key}`
    )
    assert.ok(!key.includes('待办'), '原名不该进 key —— 它只在 files.filename 那一列')
  })

  test('库里那行是 0 字节，名字用用户输入的，fileUrl 指向同一个对象', async () => {
    const { deps, puts } = makeDeps()

    const record = await createEmptyFile(db, OWNER, null, '待办.txt', deps)
    const [row] = await rows()

    assert.equal(row.user_id, OWNER)
    assert.equal(row.folder_id, null)
    assert.equal(row.filename, '待办.txt')
    assert.equal(row.file_key, puts[0])
    assert.equal(Number(row.file_size), 0, '空白文件必须是 0 字节')
    assert.equal(row.file_url, `https://cos.example/${puts[0]}`)
    assert.equal(row.Shared, 2, '新建文件默认继承分享状态')

    // 返回值也要能直接用（前端拿它做乐观更新时不该再查一次库）
    assert.equal(record.filename, '待办.txt')
    assert.equal(record.fileSize, 0)
    assert.equal(record.fileKey, puts[0])
    assert.equal(record.folderId, null)
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}/, 'createdAt 要真的回到前端承诺的形状（RETURNING 的别名）')
  })

  test('同样的名字已经存在时自动变成 (2)，扩展名留在最后', async () => {
    await raw.run(
      'INSERT INTO files (user_id, folder_id, filename, file_key, file_size, file_url) VALUES (?,?,?,?,?,?)',
      [OWNER, null, '待办.txt', 'users/77/existing', 0, 'https://cos.example/old']
    )
    const { deps, puts } = makeDeps()

    const record = await createEmptyFile(db, OWNER, null, '待办.txt', deps)

    assert.equal(record.filename, '待办 (2).txt')
    assert.match(puts[0], /\.txt$/, '追加重名后缀不能把扩展名吃掉')
    const all = await rows()
    assert.deepEqual(all.map((r) => r.filename).sort(), ['待办 (2).txt', '待办.txt'])
  })

  test('别的目录里的同名文件不算冲突', async () => {
    await raw.run(
      'INSERT INTO files (user_id, folder_id, filename, file_key, file_size, file_url) VALUES (?,?,?,?,?,?)',
      [OWNER, 5, '待办.txt', 'users/77/other-folder', 0, 'https://cos.example/x']
    )
    const { deps } = makeDeps()

    const record = await createEmptyFile(db, OWNER, null, '待办.txt', deps)
    assert.equal(record.filename, '待办.txt')
  })

  test('桶里放不进去：错误原样抛出，数据库里不留行', async () => {
    const { deps, deletes } = makeDeps({ putThrows: true })

    await assert.rejects(
      () => createEmptyFile(db, OWNER, null, '待办.txt', deps),
      /桶挂了/
    )
    assert.deepEqual(await rows(), [], '对象没放上去，就不该有一条指向不存在对象的记录')
    assert.deepEqual(deletes, [], '都没放上去，没有东西可删')
  })

  test('名字不合法时连对象都不放', async () => {
    const { deps, puts } = makeDeps()

    await assert.rejects(
      () => createEmptyFile(db, OWNER, null, 'a/b.txt', deps),
      (e) => e.statusCode === 400
    )

    assert.deepEqual(puts, [], '注定失败的请求不该先往桶里写一个对象')
    assert.deepEqual(await rows(), [])
  })

  test('写库失败：把刚放上去的对象删掉，别留孤儿', async () => {
    const { deps, puts, deletes } = makeDeps()
    const spied = spyDb(db, { failEveryInsert: 'boom: 数据库只读' })

    await assert.rejects(
      () => createEmptyFile(spied, OWNER, null, '待办.txt', deps),
      /数据库只读/
    )

    assert.equal(puts.length, 1)
    assert.deepEqual(deletes, puts, '删的必须正是刚放上去的那一个')
    assert.deepEqual(await rows(), [])
  })

  test('清理本身失败也不能盖掉真正的原因', async () => {
    const { deps } = makeDeps({ deleteThrows: true })
    const spied = spyDb(db, { failEveryInsert: 'boom: 数据库只读' })

    await assert.rejects(
      () => createEmptyFile(spied, OWNER, null, '待办.txt', deps),
      /数据库只读/,
      '原始错误必须原样传出去 —— 用户要看到的是「为什么没建成」，不是「删不掉」'
    )
  })

  test('并发撞名：撞上唯一约束就换个名字重试，而且不重新放对象', async () => {
    const { deps, puts } = makeDeps()
    const spied = spyDb(db, { failFirstInsert: FILENAME_UNIQUE })

    const record = await createEmptyFile(spied, OWNER, null, '待办.txt', deps)

    assert.equal(spied.attempts, 2, '第一次撞名后应该再插一次')
    assert.equal(record.filename, '待办 (2).txt')
    assert.equal(puts.length, 1, 'key 里没有原名，换名字不需要重新放对象')
    assert.equal((await rows()).length, 1)
  })

  test('file_key 撞车不是重名，不该靠改名重试', async () => {
    const { deps } = makeDeps()
    const spied = spyDb(db, { failEveryInsert: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: files.file_key' })

    await assert.rejects(
      () => createEmptyFile(spied, OWNER, null, '待办.txt', deps),
      /files\.file_key/
    )
    assert.equal(spied.attempts, 1, 'file_key 冲突改多少次名字都没用')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 接线。上面那节跑的是真函数（名字校验、put/insert 顺序、清理、重名重试）；
// 这一节只能看源码 —— 端点用 Nuxt 自动导入、按钮要挂载才能点，node --test
// 两样都做不到（项目里没有 @vue/test-utils / happy-dom / Playwright）。
//
// 所以下面断的是**调用形状**：谁被调、参数是什么、入口有没有权限闸。代价写
// 明白：把这些调用改成别的名字或换掉参数会被抓到，但「点下去真的发生什么」
// 抓不到，还得在浏览器里看一眼。
// ─────────────────────────────────────────────────────────────────────────────

describe('端点 create.post.ts：路径与大小由服务端拥有', () => {
  const code = codeOnly(read('server/api/files/create.post.ts'))

  test('整份端点里不出现 fileKey / fileUrl / fileSize', () => {
    // 客户端只要能指定其中任何一个，就等于能往别人的命名空间里写对象
    // （历史漏洞见 server/utils/file-key.ts 的说明）。空白文件这整条路上
    // 这三个值都该由服务端算出来，所以连提都不该提。
    for (const forbidden of ['fileKey', 'fileUrl', 'fileSize']) {
      assert.ok(
        !code.includes(forbidden),
        `端点里出现了 ${forbidden} —— 空白文件的对象路径/大小/直链必须由服务端决定`
      )
    }
  })

  test('只从 body 取 filename 与 folderId', () => {
    assert.match(code, /const filename = body\.filename/, '名字只从 body.filename 取')
    assert.match(code, /normalizeFolderId\(body\.folderId\)/, '目录走 normalizeFolderId（与上传/保存同一套）')
  })

  test('目标目录按 PERM_WRITE 校验，属主取自目录', () => {
    assert.match(
      code,
      /findAccessibleById\(authId,\s*folderId,\s*PERM_WRITE\)/,
      '必须问「我对这个目录有没有写权限」—— 缺了就是任何人往任何目录建文件'
    )
    assert.match(code, /ownerId = dest\.userId/, '文件归属父目录的属主，不是发起请求的人')
    assert.match(code, /createEmptyFile\(db, ownerId, folderId/, '传给核心的是属主，不是 authId')
  })

  test('过期账号不能新建（0 字节也不吃配额，但「还能不能写」要判）', () => {
    // 新建空文件不预占容量（见端点里的说明），所以配额链的接线测试不会把
    // 这份端点扫进去。过期这一道只能在这里钉住。
    assert.match(code, /if \(expiredOn\.self\) throw userExpiredError/)
    assert.match(
      code,
      /if \(expiredOn\.parent\) \{[\s\S]{0,200}?quotaFailMessage\(db, 'expired_parent'/,
      '主账号过期要挡住子账户，且文案要走 quotaFailMessage（说清是哪一层过期）'
    )
  })

  test('三个依赖接的是真的 COS 实现（不是空实现）', () => {
    assert.match(code, /putEmptyObject,/, '没接真实的上传实现')
    assert.match(code, /deleteObject: deleteCosObject/, '失败清理没接到删对象上')
    assert.match(code, /objectUrl: cosObjectUrl/, '直链没接真实的构造')
  })
})

describe('前端接线：输入框、服务、按钮', () => {
  const svc = codeOnly(read('app/services/files.service.ts'))
  const editing = codeOnly(read('app/composables/useNameEditing.ts'))

  test('FilesService.create 打的是 /api/files/create，并带上作用域', () => {
    const block = blockOf(svc, 'async create(filename: string')
    assert.match(block, /'\/api\/files\/create'/, '端点写错了 —— 建文件不该复用建目录那个')
    assert.match(block, /withScope\(body, \{ targetUserId, useAdmin \}\)/, '必须带作用域，否则管理端代建不生效')
    assert.match(block, /filename, folderId/, '只送名字与目录')
  })

  test('useNameEditing.createFile：先问名字，取消就什么都不做', () => {
    const block = blockOf(editing, 'const createFile = async () =>')
    assert.match(block, /await openPrompt\(\{/, '必须真的弹窗问名字')
    assert.match(block, /title: '新建文件'/, '标题要短（「新建文件」）')
    assert.match(block, /label: '文件名'/)
    assert.match(block, /trim: true/, '名字要 trim —— 「 a」与「a」在列表里看着一样')
    assert.match(block, /confirmText: '创建'/)
    assert.match(block, /validate: nameValidator\(false\)/, '文件名校验不能按目录名那套（不能挡点）')
    assert.match(block, /if \(!name\) return/, '取消（null）与空值都该直接返回')
  })

  test('useNameEditing.createFile：提交后刷新列表', () => {
    const block = blockOf(editing, 'const createFile = async () =>')
    assert.match(
      block,
      /FilesService\.create\(name, currentFolderId\.value \?\? null, tRef\?\.value \?\? null, admin\(\)\)/,
      '参数顺序/作用域要与建目录一致'
    )
    assert.match(block, /await fetchFiles\(\)/, '建完不刷新，新建的文件不会出现')
    assert.match(block, /notifyError\(e, '新建文件失败'\)/, '失败要说清是哪一步')
  })

  test('FileBrowser 从 useNameEditing 里取到了 createFile', () => {
    assert.match(editing, /return \{\s*createFolder,\s*createFile,/, 'composable 没有导出 createFile')
    const browser = codeOnly(read('app/components/FileBrowser.vue'))
    assert.match(browser, /const \{ createFolder, createFile, renameFolder, renameFile \} = useNameEditing\(/)
  })

  const { descriptor } = parse(read('app/components/FileBrowser.vue'), { filename: 'FileBrowser.vue' })
  const tpl = codeOnly(descriptor.template?.content ?? '')
  const buttons = [...tpl.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])

  test('桌面按钮：图标、原生 title、aria-label，且只在可写目录出现', () => {
    const desktop = buttons.find((b) => /@click="createFile"/.test(b))
    assert.ok(desktop, '没有那颗「新建文件」按钮')
    assert.match(desktop, /v-if="canWriteHere"/, '只读目录 / 分享链接视角不该出现新建入口')
    assert.match(desktop, /title="新建文件"/, '图标按钮要靠原生 title 说明用途')
    assert.match(desktop, /aria-label="新建文件"/, '图标按钮必须有可读名称')
    const after = tpl.slice(tpl.indexOf(desktop) + desktop.length).trimStart()
    assert.match(after, /^<DocumentPlusIcon/, '图标没换 —— 会留一个空按钮')
  })

  test('移动端「更多」菜单里也有一个（带文字）', () => {
    const mobile = buttons.find((b) => /@click="createFile\(\); mobileMoreOpen = false"/.test(b))
    assert.ok(mobile, '移动端没有新建文件的入口 —— 桌面那个是 hidden sm:inline-flex')
    assert.match(mobile, /v-if="canWriteHere"/)
    const after = tpl.slice(tpl.indexOf(mobile) + mobile.length).trimStart()
    assert.match(after, /^<DocumentPlusIcon[^>]*\/>新建文件/, '菜单项要用文字说明，不是一个裸图标')
  })
})
