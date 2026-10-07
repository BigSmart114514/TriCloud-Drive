// 对账逻辑的行为测试（调真函数，db 与 lister 注入假实现）。
//
// ## 为什么核心是对账而不是端点
//
// 这个功能里最容易写错的全��「失败时怎么办」：
//
//   DB 读失败        → 若当成空集，差集 = 整个桶，而孤儿列表带删除按钮
//   COS 列举只到 1/40 → 悬空行里绝大多数是假的，用户会收到「文件丢失」假警报
//   对象年龄算不出   → 若当「够旧」处理，正在上传的文件会被删
//   key 属主对不上   → 若静默丢弃，就再也没人知道它存在
//
// 这四个分支在真机上可能一辈子遇不到一次。所以 bucket-reconcile.ts 做成
// db/lister 都注入，这里就能把它们**真的跑一遍**。端点那边只有 SQL 与参数
// 拼装，测它不如测这里。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { reconcileUserBucket, partitionPurgeableKeys, DEFAULT_ORPHAN_MIN_AGE_MS } =
  await import('../server/utils/bucket-reconcile.ts')

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** 一行 files 记录 */
function row(id, fileKey, over = {}) {
  return {
    id,
    fileKey,
    filename: over.filename ?? `f${id}.txt`,
    folderId: over.folderId ?? null,
    fileSize: over.fileSize ?? 1000,
    createdAt: over.createdAt ?? '2026-10-01T00:00:00Z'
  }
}

/** 一个 COS 对象 */
function obj(key, over = {}) {
  return {
    key,
    size: over.size ?? 1000,
    lastModified: over.lastModified ?? new Date(NOW - 30 * DAY).toISOString()
  }
}

/**
 * 组 deps。默认给一个「一切正常」的实现，每个用例只覆盖自己关心的那一项。
 *
 * rows 默认为空、objects 默认为空 —— 于是「什么都不发生」时结果是零孤儿零悬空，
 * 用例要制造偏差才看得出差别。
 */
function deps(over = {}) {
  return {
    listNamespace: async () => ({ objects: [], incomplete: false }),
    loadRows: async () => [],
    now: NOW,
    minAgeMs: DEFAULT_ORPHAN_MIN_AGE_MS,
    ...over
  }
}

describe('线 1：DB 读失败绝不产出孤儿', () => {
  // 这是整个功能最要紧的一条。孤儿 = COS 键集 − DB 键集，所以「DB 读失败」
  // 被当成「零行」的话，差集就是**整个命名空间** —— 而孤儿列表带删除按钮。
  test('loadRows 抛异常时 orphans 为空', async () => {
    const r = await reconcileUserBucket(1, deps({
      loadRows: async () => { throw new Error('database is locked') },
      listNamespace: async () => ({
        objects: Array.from({ length: 500 }, (_, i) => obj(`users/1/202610/${i}.bin`)),
        incomplete: false
      })
    }))
    assert.deepEqual(r.orphans, [], 'DB 读失败时绝不能报出任何孤儿 —— 那 500 个全是误报')
  })

  test('loadRows 抛异常时 dangling 也为空', async () => {
    const r = await reconcileUserBucket(1, deps({
      loadRows: async () => { throw new Error('boom') },
      listNamespace: async () => ({ objects: [], incomplete: false })
    }))
    assert.deepEqual(r.dangling, [])
    assert.match(r.error, /读取该用户的文件记录失败/)
  })

  // 「读失败」与「这个用户一个文件都没有」必须能分开。后者是正常状态，
  // 不该让人以为出了故障。
  test('loadRows 正常返回空数组时没有 error（那是合法状态，不是故障）', async () => {
    const r = await reconcileUserBucket(1, deps({
      loadRows: async () => [],
      listNamespace: async () => ({ objects: [], incomplete: false })
    }))
    assert.equal(r.error, undefined, '零行是合法状态，不该被当成读失败')
    assert.deepEqual(r.orphans, [])
    assert.deepEqual(r.dangling, [])
  })

  test('error 里写明了「未做任何比对」，让人知道这不是「扫过了没发现」', async () => {
    const r = await reconcileUserBucket(1, deps({
      loadRows: async () => { throw new Error('x') }
    }))
    assert.match(r.error, /未做任何比对/, '措辞要让操作者知道这不是「查过了、没问题」')
  })
})

describe('线 2：列举不完整时悬空行整个不产出', () => {
  // 悬空 = DB 键集 − COS 键集。COS 侧只列到 1/40 时，这个差集里绝大多数
  // 是假的 —— 而管理员会当真，用户也会当真，然后拿一条不存在的文件丢失来问。
  test('incomplete 时 dangling 为空', async () => {
    const r = await reconcileUserBucket(7, deps({
      loadRows: async () => [row(1, 'users/7/202610/a.txt'), row(2, 'users/7/202609/b.txt')],
      listNamespace: async () => ({
        objects: [obj('users/7/202610/a.txt')],
        incomplete: true,
        error: '第 2 页列举失败：timeout'
      })
    }))
    assert.deepEqual(r.dangling, [], '列举不完整时不能报悬空 —— 那些文件其实好好的')
    assert.match(r.danglingSuppressedReason, /timeout/)
  })

  test('incomplete 时给了「为什么压制」的理由，而不是空白', async () => {
    // 一行空白会让人以为「没有悬空行」，而实际是「不敢报」。这两件事差别很大。
    const r = await reconcileUserBucket(7, deps({
      loadRows: async () => [row(1, 'users/7/202610/a.txt')],
      listNamespace: async () => ({ objects: [], incomplete: true })
    }))
    assert.ok(r.danglingSuppressedReason, '必须给出压制原因')
    assert.match(r.danglingSuppressedReason, /无法与「只是没翻到」区分/)
  })

  test('incomplete 没有 error 时也用默认理由说明', async () => {
    const r = await reconcileUserBucket(7, deps({
      loadRows: async () => [row(1, 'users/7/202610/a.txt')],
      listNamespace: async () => ({ objects: [], incomplete: true })
    }))
    assert.ok(r.danglingSuppressedReason)
    assert.equal(r.incomplete, true, 'incomplete 标志本身要透出')
  })

  test('列举完整时悬空行正常产出（对照组：不是一律压制）', async () => {
    const r = await reconcileUserBucket(7, deps({
      loadRows: async () => [row(1, 'users/7/202610/a.txt'), row(2, 'users/7/202609/gone.txt')],
      listNamespace: async () => ({
        objects: [obj('users/7/202610/a.txt')],
        incomplete: false
      })
    }))
    assert.equal(r.dangling.length, 1)
    assert.equal(r.dangling[0].id, 2, 'b.txt 的对象没了，那一行才是悬空')
    assert.equal(r.danglingSuppressedReason, undefined)
  })
})

describe('线 3：列举不完整时孤儿全部不可删', () => {
  test('incomplete 时孤儿 deletable 为 false', async () => {
    const r = await reconcileUserBucket(3, deps({
      listNamespace: async () => ({
        // 30 天前的对象，够旧
        objects: [obj('users/3/202608/old.bin')],
        incomplete: true
      })
    }))
    assert.equal(r.orphans.length, 1)
    assert.equal(r.orphans[0].deletable, false,
      '列举坏了时分不清「列举真的穷尽了」与「列举坏了」，按坏的算')
  })

  test('列举完整且够旧时 deletable 为 true（对照组）', async () => {
    const r = await reconcileUserBucket(3, deps({
      listNamespace: async () => ({ objects: [obj('users/3/202608/old.bin')], incomplete: false })
    }))
    assert.equal(r.orphans[0].deletable, true)
  })
})

describe('年龄下限：挡住「正在上传」', () => {
  // 上传是 credentials → 客户端直传 COS → files/save。第二步之后对象存在、
  // 行还不存在，中间没有任何标记能说明它在途（本项目服务器不代理字节）。
  // 所以「够不够旧」是唯一的判据。
  test('刚上传的对象不算可删（哪怕它确实没有行）', async () => {
    const r = await reconcileUserBucket(1, deps({
      listNamespace: async () => ({
        objects: [obj('users/1/202610/fresh.bin', {
          lastModified: new Date(NOW - 60 * 1000).toISOString()   // 1 分钟前
        })],
        incomplete: false
      })
    }))
    assert.equal(r.orphans.length, 1, '它是孤儿，这点没错')
    assert.equal(r.orphans[0].deletable, false, '但不能删 —— 可能正在上传')
  })

  test('超过 24 小时就可删', async () => {
    const r = await reconcileUserBucket(1, deps({
      listNamespace: async () => ({
        objects: [obj('users/1/202609/old.bin', {
          lastModified: new Date(NOW - 25 * DAY).toISOString()
        })],
        incomplete: false
      })
    }))
    assert.equal(r.orphans[0].deletable, true)
  })

  test('恰好等于下限时可删（边界是 >= 不是 >）', async () => {
    const r = await reconcileUserBucket(1, deps({
      listNamespace: async () => ({
        objects: [obj('users/1/202609/x.bin', {
          lastModified: new Date(NOW - DEFAULT_ORPHAN_MIN_AGE_MS).toISOString()
        })],
        incomplete: false
      })
    }))
    assert.equal(r.orphans[0].deletable, true, '恰好到点就该可删，不该被 < 挡掉')
  })

  // 「证明不了它够旧」与「它很新」同等待遇：都不可删。
  test('lastModified 解析不了时 ageMs 为 null 且不可删', async () => {
    const r = await reconcileUserBucket(1, deps({
      listNamespace: async () => ({
        objects: [obj('users/1/202610/weird.bin', { lastModified: 'not-a-date' })],
        incomplete: false
      })
    }))
    assert.equal(r.orphans[0].ageMs, null)
    assert.equal(r.orphans[0].deletable, false)
  })

  test('lastModified 缺失（空串）同样不可删', async () => {
    const r = await reconcileUserBucket(1, deps({
      listNamespace: async () => ({
        objects: [obj('users/1/202610/x.bin', { lastModified: '' })],
        incomplete: false
      })
    }))
    assert.equal(r.orphans[0].deletable, false)
  })

  test('ageMs 恒为非负（未来的时间戳不该算出负数年龄）', async () => {
    const r = await reconcileUserBucket(1, deps({
      listNamespace: async () => ({
        // 服务器时钟超前于 COS
        objects: [obj('users/1/202610/future.bin', {
          lastModified: new Date(NOW + 3 * DAY).toISOString()
        })],
        incomplete: false
      })
    }))
    assert.equal(r.orphans[0].ageMs, 0, '负数年龄会让界面显示「-72 小时」，很难解释')
    assert.equal(r.orphans[0].deletable, false)
  })
})

describe('两个前缀都被覆盖', () => {
  // FILE_KEY_PREFIXES = ['users', 'u']。漏掉一个前缀的表现是
  // 「那个前缀下的对象全都不见了」，而且没有任何报错。
  test('u/ 前缀下的孤儿也能被找到', async () => {
    const r = await reconcileUserBucket(5, deps({
      listNamespace: async () => ({
        objects: [obj('u/5/2026-09-01/1700_abc_report.xlsx')],
        incomplete: false
      })
    }))
    assert.equal(r.orphans.length, 1, 'u/ 前缀的副本也是真实对象')
    assert.equal(r.orphans[0].key, 'u/5/2026-09-01/1700_abc_report.xlsx')
  })

  test('两个前缀混在一起时都被扫到', async () => {
    const r = await reconcileUserBucket(5, deps({
      loadRows: async () => [row(1, 'users/5/202610/keep.txt')],
      listNamespace: async () => ({
        objects: [
          obj('users/5/202610/keep.txt'),
          obj('users/5/202609/lost-a.bin'),
          obj('u/5/2026-09-01/lost-b.bin')
        ],
        incomplete: false
      })
    }))
    assert.equal(r.orphans.length, 2, 'users 与 u 两个前缀下各有一个孤儿')
    assert.deepEqual(r.orphans.map(o => o.key).sort(), [
      'u/5/2026-09-01/lost-b.bin',
      'users/5/202609/lost-a.bin'
    ])
    assert.deepEqual(r.dangling, [], 'b.txt 那行有对象，不该算悬空')
  })

  test('两个前缀下都能找到悬空行', async () => {
    const r = await reconcileUserBucket(5, deps({
      loadRows: async () => [
        row(1, 'users/5/202610/a.txt'),
        row(2, 'u/5/2026-09-01/b.txt')
      ],
      listNamespace: async () => ({ objects: [], incomplete: false })
    }))
    assert.equal(r.dangling.length, 2)
  })
})

describe('形状对不上的条目：报出来，不丢掉', () => {
  test('不在该用户命名空间下的 COS 对象进 foreignObjects', async () => {
    const r = await reconcileUserBucket(5, deps({
      listNamespace: async () => ({
        objects: [
          obj('users/5/202610/mine.bin'),
          obj('users/9/202610/other.bin'),   // 别人的
          obj('somewhere/else/x.bin')          // 完全不认识的前缀
        ],
        incomplete: false
      })
    }))
    // 不许当成孤儿：删了就是删别人的东西
    assert.deepEqual(r.orphans.map(o => o.key), ['users/5/202610/mine.bin'])
    assert.equal(r.foreignObjects.length, 2)
    assert.ok(r.foreignObjects.includes('users/9/202610/other.bin'))
    assert.ok(r.foreignObjects.includes('somewhere/else/x.bin'))
  })

  test('属主解析不出来的行进 foreignRows，且不算悬空', async () => {
    const r = await reconcileUserBucket(5, deps({
      loadRows: async () => [
        row(1, 'garbage'),              // 一段都不像
        row(2, 'users/9/202610/x.bin'),  // 属主是别人
        row(3, 'users/5/202610/ok.txt')
      ],
      listNamespace: async () => ({ objects: [], incomplete: false })
    }))
    assert.equal(r.foreignRows.length, 2)
    assert.deepEqual(r.dangling.map(d => d.id), [3],
      '只有属主正确且对象缺失的才算悬空')
  })

  test('foreignRows 保留了解析出来的属主，便于人工判断', async () => {
    const r = await reconcileUserBucket(5, deps({
      loadRows: async () => [row(1, 'users/9/202610/x.bin')],
      listNamespace: async () => ({ objects: [], incomplete: false })
    }))
    assert.equal(r.foreignRows[0].ownerId, 9, '要告诉人「它指向的是 9」，而不是只说「不认识」')
  })

  test('空 file_key 既不算悬空也不进 foreignRows（脏数据，没有可处理的对象）', async () => {
    const r = await reconcileUserBucket(5, deps({
      loadRows: async () => [row(1, ''), row(2, 'users/5/202610/ok.txt')],
      listNamespace: async () => ({ objects: [], incomplete: false })
    }))
    assert.deepEqual(r.dangling.map(d => d.id), [2],
      '空 key 不能拿去 COS 比对 —— 拿它比必然「COS 没有」，于是报成悬空')
    // 值得说清为什么不报：空 file_key 解析不出属主，若不特判就会落进
    // foreignRows（那里收的正是「属主解析不出来」的行），于是每次对账
    // 都有一条永远不变的噪音，把真正需要人看的行淹掉。
    assert.deepEqual(r.foreignRows, [], '空 key 是没意义的脏数据，不是「形状不认识的对象」')
  })
})

describe('scanned 计数要如实反映扫了多少', () => {
  test('scannedObjects 与 scannedRows 分别是 COS 与 DB 侧的数量', async () => {
    const r = await reconcileUserBucket(5, deps({
      loadRows: async () => [row(1, 'users/5/202610/a.txt'), row(2, 'users/5/202610/b.txt')],
      listNamespace: async () => ({
        objects: [obj('users/5/202610/a.txt'), obj('users/5/202609/x.bin')],
        incomplete: false
      })
    }))
    assert.equal(r.scannedObjects, 2)
    assert.equal(r.scannedRows, 2)
  })

  // 比例是管理员判断「这个数对不对」的唯一依据。
  test('DB 读失败时 scannedRows 为 0（不是把「零行」当结论）', async () => {
    const r = await reconcileUserBucket(5, deps({
      loadRows: async () => { throw new Error('x') },
      listNamespace: async () => ({ objects: [], incomplete: false })
    }))
    assert.equal(r.scannedRows, 0)
    assert.ok(r.error)
  })
})

describe('空结果不炸', () => {
  test('什么都没扫到时字段齐全', async () => {
    const r = await reconcileUserBucket(5, deps())
    assert.deepEqual(r.orphans, [])
    assert.deepEqual(r.dangling, [])
    assert.deepEqual(r.foreignObjects, [])
    assert.deepEqual(r.foreignRows, [])
    assert.equal(r.incomplete, false)
    assert.equal(r.userId, 5)
  })
})

describe('partitionPurgeableKeys：purge 前的复查', () => {
  // 这道复查不复用对账的快照 —— 对账到点删除之间可能过了几秒也可能一天，
  // 用户在这期间完成了一次上传，于是那个「孤儿」此刻已经有行了。
  test('通过命名空间且仍无行的 key 放行', () => {
    const { ok, rejected } = partitionPurgeableKeys(['users/5/202610/a.bin'], [], 5)
    assert.deepEqual(ok, ['users/5/202610/a.bin'])
    assert.deepEqual(rejected, [])
  })

  test('已经有行的 key 被拒（对账之后用户完成了一次上传）', () => {
    const { ok, rejected } = partitionPurgeableKeys(
      ['users/5/202610/a.bin'],
      [row(1, 'users/5/202610/a.bin')],
      5
    )
    assert.deepEqual(ok, [])
    assert.equal(rejected.length, 1)
    assert.match(rejected[0].reason, /已经有 files 行指向它了/)
  })

  // 结构性守卫：让跨用户删除不可能发生，而不是靠页面上禁按钮。
  test('别人命名空间下的 key 被拒', () => {
    const { ok, rejected } = partitionPurgeableKeys(['users/9/202610/x.bin'], [], 5)
    assert.deepEqual(ok, [])
    assert.match(rejected[0].reason, /不在用户 5 的命名空间下/)
  })

  test('u/ 前缀下别人家的同样被拒', () => {
    const { ok } = partitionPurgeableKeys(['u/9/2026-09-01/x.bin'], [], 5)
    assert.deepEqual(ok, [], 'u/ 也得守，不能因为前缀不同就漏')
  })

  test('不认识的顶层前缀被拒（不能靠伪造前缀越权）', () => {
    const { ok, rejected } = partitionPurgeableKeys(['../../etc/passwd', 'u/../5/x'], [], 5)
    assert.deepEqual(ok, [])
    assert.equal(rejected.length, 2)
  })

  test('路径穿越式的 key 被拒', () => {
    const { ok } = partitionPurgeableKeys(['users/5/../../9/secret.bin'], [], 5)
    assert.deepEqual(ok, [], '前缀匹配不做路径规范化 —— users/5/../.. 逃出命名空间')
  })

  test('非字符串与空串被拒而不是崩溃', () => {
    const { ok, rejected } = partitionPurgeableKeys(['', null, undefined, 42], [], 5)
    assert.deepEqual(ok, [])
    assert.equal(rejected.length, 4)
  })

  test('理由里点名了允许的前缀，方便操作者理解', () => {
    const { rejected } = partitionPurgeableKeys(['x/y'], [], 5)
    assert.match(rejected[0].reason, /users\/5\//)
  })
})