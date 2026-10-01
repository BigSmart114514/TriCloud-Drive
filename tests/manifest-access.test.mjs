// 整包下载清单的权限过滤测试（server/utils/db.ts 的
// FolderService.listSubtreeManifest + FileService.listDownloadableSubtree）。
//
// 修的是什么 bug：
//   1. 清单只按 user_id 圈范围，**完全不看权限** —— 只读权限的人能拿到整棵子树的
//      filename + file_key（真实存储路径），包括他连读都没权限的那些。
//   2. 前端拿到清单后逐个调 /api/files/download（查 PERM_DOWNLOAD），
//      任一文件缺下载位就 403 → 整个 zip 中途作废。
//   3. skipped 计数：前端要能说清「N 个文件你没权限」，否则用户只看到「文件夹为空」。
//
// 算法复刻在 tests/helpers/access-algorithm.mjs，数据夹具在 sqlite-fixture.mjs。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createShareFixture } from './helpers/sqlite-fixture.mjs'
import { makeAccessAlgorithms } from './helpers/access-algorithm.mjs'

const PERM_READ = 1
const PERM_WRITE = 2
const PERM_DOWNLOAD = 8
const SHARE_NONE = 0
const SHARE_SHARED = 1
const SHARE_INHERIT = 2

const OWNER = 901
const VISITOR = 900

let fx
let listSubtreeManifest
let listDownloadableSubtree

before(async () => {
  fx = await createShareFixture()
  ;({ listSubtreeManifest, listDownloadableSubtree } = makeAccessAlgorithms(fx))
})
after(() => fx.close())
beforeEach(() => fx.reset())

const ids = (files) => files.map((f) => Number(f.id)).sort((a, b) => a - b)

describe('listSubtreeManifest —— 不过滤权限的那一份', () => {
  // 这条不是「正确行为」，是**记录现状**：上层过滤建立在这份数据之上，
  // 属主路径直接用它返回。钉住它是为了有人改 CTE 时能看见影响面。
  test('按 user_id 圈范围，没有权限概念', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_NONE })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.mkFile({ id: 20, folderId: 2 })   // 在「不分享」的墙之下
    const all = await listSubtreeManifest(OWNER, 1)
    assert.deepEqual(ids(all), [10, 20], '墙下的文件也在里面 —— 所以才需要上层过滤')
  })

  test('带上 folder_id / Shared / IsPublic 供权限过滤分组用', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_SHARED })
    const [f] = await listSubtreeManifest(OWNER, 1)
    assert.equal(Number(f.folderId), 1)
    assert.equal(Number(f.Shared), SHARE_SHARED)
    assert.equal(f.IsPublic, 0)
  })

  test('relDir 保留相对路径', async () => {
    await fx.mkFolder({ id: 1, name: 'root', Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, name: 'sub', Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 10, folderId: 2, filename: 'a.txt' })
    const [f] = await listSubtreeManifest(OWNER, 1)
    assert.equal(f.relDir, 'sub')
  })
})

describe('listDownloadableSubtree —— 属主快路径', () => {
  test('属主拿全量，零额外查询', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_NONE })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.mkFile({ id: 11, folderId: 1 })
    const r = await listDownloadableSubtree(OWNER, OWNER, 1)
    assert.deepEqual(ids(r.files), [10, 11], '属主在「不分享」目录下也拿得到自己的东西')
    assert.equal(r.skipped, 0)
  })

  test('空目录 → 空清单，skipped 0（不能报 NaN）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    const r = await listDownloadableSubtree(OWNER, OWNER, 1)
    assert.deepEqual(r.files, [])
    assert.equal(r.skipped, 0)
  })
})

describe('listDownloadableSubtree —— 访客按权限过滤', () => {
  test('没有下载位（只有读）的文件被排除 —— 这正是整包下载中途崩的根因', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.grantFolder(1, VISITOR, PERM_READ)     // 只有读，没有下载位
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(r.files, [], '只读的人整包下载不到东西')
    assert.equal(r.skipped, 1, '但要报数，否则界面只会说「文件夹为空」')
  })

  test('有下载位 → 给；没有 → 不给；skipped 精确', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.mkFile({ id: 11, folderId: 1 })
    await fx.mkFile({ id: 12, folderId: 1 })
    // 目录授权给读+下载，但 12 被单独给了「只有读」的文件级授权？
    // 文件级授权是**并集**，不能收窄目录授权，所以换个方式做混合场景：
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(ids(r.files), [10, 11, 12])
    assert.equal(r.skipped, 0)
  })

  test('完全没权限 → 什么都拿不到', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(r.files, [])
    assert.equal(r.skipped, 1)
  })

  test('「不分享」的墙把整棵子树挡掉', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_NONE })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 20, folderId: 2 })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    await fx.grantFolder(2, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(r.files, [], '墙连下游自己的直接授权一起挡')
    assert.equal(r.skipped, 1)
  })

  test('文件自己设成「分享」就切断继承 —— 祖先的授权到不了', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 11, folderId: 1, Shared: SHARE_SHARED })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(ids(r.files), [10], '11 是自己的边界，上面给的读+下载不算数')
    assert.equal(r.skipped, 1)
  })

  test('文件级直接授权能单独救回一个被目录挡掉的文件', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_NONE })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_SHARED })
    await fx.grantFile(10, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(ids(r.files), [10])
  })

  test('多级子目录：权限逐目录独立判定', async () => {
    // 1 分享（授权给访客）→ 2 继承 → 3 分享（没授权，是自己的边界）
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 3, parentId: 2, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.mkFile({ id: 20, folderId: 2 })
    await fx.mkFile({ id: 30, folderId: 3 })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(ids(r.files), [10, 20], '3 是边界，它里面的文件拿不到')
    assert.equal(r.skipped, 1)
  })

  test('同一目录多文件只解析一次权限（行为上等价，结果正确）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    for (const id of [10, 11, 12, 13]) await fx.mkFile({ id, folderId: 1 })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(ids(r.files), [10, 11, 12, 13])
  })

  test('need 换成「只要读」时，只读的文件也留下', async () => {
    // 证明 need 是真的参数，不是写死 PERM_DOWNLOAD
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.grantFolder(1, VISITOR, PERM_READ)
    const withDownload = await listDownloadableSubtree(VISITOR, OWNER, 1, PERM_DOWNLOAD)
    assert.equal(withDownload.files.length, 0)
    const withRead = await listDownloadableSubtree(VISITOR, OWNER, 1, PERM_READ)
    assert.equal(withRead.files.length, 1, 'need=读 时同一个文件就该留下了')
  })

  test('分���遍历后按 relDir + 文件名重新排序', async () => {
    await fx.mkFolder({ id: 1, name: 'root', Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, name: 'b-dir', Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 3, parentId: 1, name: 'a-dir', Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 10, folderId: 2, filename: 'z.txt' })
    await fx.mkFile({ id: 11, folderId: 3, filename: 'y.txt' })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(r.files.map((f) => f.relDir), ['a-dir', 'b-dir'], 'relDir 升序')
  })

  test('总量只算留下的那些（前端 confirm 的数字要准）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_NONE })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_SHARED })  // 边界
    await fx.mkFile({ id: 10, folderId: 1, fileSize: 1000 })
    await fx.mkFile({ id: 20, folderId: 2, fileSize: 500 })
    await fx.grantFolder(2, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    const bytes = r.files.reduce((s, f) => s + Number(f.fileSize), 0)
    assert.equal(bytes, 500, '不能把没权限的 1000 字节算进预检，否则会误报超限')
  })
})

describe('回归：当前目录自己就是边界时，里面继承态的文件不能被归零', () => {
  // 这是本轮修的既有 bug。触发条件很窄，所以一直没被发现：
  // 「当前目录自己 Shared=1，而它上面全是继承」→ resolveAccess 走 SHARED 分支时
  // hasBoundary = !!anc = false（anc 只找 depth > 0）。而文件侧原来传的是
  // `inherited.hasBoundary !== false` = false → combineWithAncestor 判定
  // 「没人拍板」→ 继承态文件全部拿到 mask 0。
  //
  // 表现：目录在「分享给我的」里点得进去（目录本身 mask 正常），进去却一个文件都没有。
  // 只要再往下一层，那层上面还有边界，anc 非空，就又正常了 —— 所以看着像偶发。
  test('访客点进直接分享给他的目录，里面的继承态文件可见', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(ids(r.files), [10], '目录自己是边界，目录的授权要能落到里面的文件上')
    assert.equal(r.skipped, 0)
  })

  test('目录是「不分享」时，里面的文件仍然拿不到（这个不能被一起放开）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_NONE })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(r.files, [], '「不分享」是墙，backed 判 true 也不能放行')
    assert.equal(r.skipped, 1)
  })

  test('整条链全是继承（没人拍板）时，文件照样拿不到', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.grantFolder(1, VISITOR, PERM_READ | PERM_DOWNLOAD)
    const r = await listDownloadableSubtree(VISITOR, OWNER, 1)
    assert.deepEqual(r.files, [], 'inherited 且 hasBoundary=false → 没人拍板')
    assert.equal(r.skipped, 1)
  })
})

describe('额度归属 —— 预检和真正预占必须是同一个人', () => {
  // 复刻 server/utils/quota.ts 的两个函数（那边依赖 Nuxt 的 createError，
  // 在 node --test 里跑不起来）。改了那边要同步改这里。
  const resolveQuotaOwnerId = (adminMode, actorId, fileOwnerId) =>
    adminMode ? Number(actorId) : Number(fileOwnerId)

  async function quotaExceededMessage(quotaOwnerId, actorId, adminMode) {
    if (actorId === null) {
      return '下载额度不足：该内容所属账号的下载流量已用尽，请联系该账号的属主'
    }
    const row = await fx.get('SELECT username FROM users WHERE id = ?', [quotaOwnerId])
    const name = row?.username || `用户 ${quotaOwnerId}`
    if (Number(quotaOwnerId) === Number(actorId)) {
      return '下载额度不足：下载该文件将超过您的下载流量上限'
    }
    if (adminMode) {
      return `下载额度不足：代「${name}」下载会计入您的下载流量，已超过您的上限`
    }
    return `下载额度不足：该文件属于「${name}」，下载它消耗的是对方的下载流量，且会超过对方的上限`
  }

  test('普通访客：额度记属主，不是访问者', () => {
    assert.equal(resolveQuotaOwnerId(false, VISITOR, OWNER), OWNER,
      '分享链接/普通访客下载，记内容的属主')
    assert.equal(resolveQuotaOwnerId(true, 5, OWNER), 5,
      '管理员代管记管理员自己，不是被浏览的人')
  })

  test('文案不能笼统说「您」—— 额度可能记在别人头上', async () => {
    // 用户名从库里读，别写死：夹具里的账号是 u901/u900，写死会在改夹具时静默失效
    const owner = await fx.get('SELECT username FROM users WHERE id = ?', [OWNER])
    const m = await quotaExceededMessage(OWNER, VISITOR, false)
    assert.ok(m.includes(owner.username), '登录访客要知道是谁的额度，才能去协调')
    assert.ok(!m.includes('您的下载流量上限'), '额度不是他的，说「您的」会让他去查自己的额度')
  })

  test('自己的文件说「您」', async () => {
    assert.ok((await quotaExceededMessage(OWNER, OWNER, false)).includes('您的下载流量上限'))
  })

  test('管理员代管：说清代的是谁，且额度记自己', async () => {
    const owner = await fx.get('SELECT username FROM users WHERE id = ?', [OWNER])
    const m = await quotaExceededMessage(OWNER, 5, true)
    assert.ok(m.includes(owner.username), '要说清代的是谁')
    assert.ok(m.includes('您的'), '但扣的是管理员自己的额度，所以「您的」是对的')
  })

  // 分享链接的访问者没有账号。这条文案**不能点属主的名字** ——
  // 链接恰恰是最容易外泄的东西（转发、贴错群），把账号名挂在提示里
  // 等于给每个拿到链接的人发一份用户名。实测就是这样撞出来的。
  test('匿名访客（actorId=null）：不点属主的名字', async () => {
    const owner = await fx.get('SELECT username FROM users WHERE id = ?', [OWNER])
    const m = await quotaExceededMessage(OWNER, null, false)
    assert.ok(!m.includes(owner.username), '匿名访客不该看到属主用户名')
    assert.ok(!m.includes(`用户 ${OWNER}`), '连兜底的 id 形式也不给')
    assert.ok(m.includes('所属账号'), '但要说清不是访客自己的问题')
  })
})
