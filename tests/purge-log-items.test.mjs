// 清理审计载荷的解读（app/utils/purge-log.ts）。
//
// ## 为什么这值得单独测，而且要**执行**而不是断言源码
//
// payload 是这份审计里唯一**不可再生**的东西 —— 对象删了、files 行删了，
// 只剩这段 JSON。而两种 kind 写进去的形状不同：
//
//   dangling-row  { id, fileKey, filename, folderId, fileSize, createdAt }
//   orphan-object { key }
//
// 界面上把形状认错的后果是双向的：
//   把 orphan-object 当 dangling-row  → 显示出一个根本不存在的「原文件名」
//   把 dangling-row 当 orphan-object  → 用户投诉文件不见了，而证据被藏起来了
//
// 这些用正则断言「源码里有这句话」测不出来 —— 真正要验的是**给定一段
// payload JSON，输出的是不是对应形状的解读**。所以这里直接调函数。
//
// ## 另一个不能省的性质
//
// 载荷解不开时**不能返回空数组**。返回空 = 界面上显示「这次没删过什么」，
// 而实际上删了 —— 比报错糟得多，因为报错会有人去查。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { purgeItems, UNREADABLE_PAYLOAD_NOTE } = await import('../app/utils/purge-log.ts')

/** 包成 listPurgeLog 会返回的那种行 */
const row = (payload, over = {}) => ({
  id: 1,
  kind: 'dangling-row',
  userId: 43,
  count: 1,
  bytes: 0,
  actorId: 5,
  payload,
  createdAt: '2026-10-07 07:18:29',
  ...over
})

describe('orphan-object：只有 key，不许凭空造出文件名', () => {
  test('真库里的那一条（u/ 命名空间，key 里带原名）', () => {
    // 这条是从真 bucket_purge_log 表里抄的，不是编的
    const items = purgeItems(row('[{"key":"u/43/2026-10-01/1790898616550_p5bq2v_未命名1.cpp"}]', {
      kind: 'orphan-object'
    }))
    assert.equal(items.length, 1)
    assert.equal(items[0].key, 'u/43/2026-10-01/1790898616550_p5bq2v_未命名1.cpp')
    // 关键：key 里那截中文**不能**被当成文件名显示出来。
    // 界面上一旦出现「文件名：未命名1.cpp」，操作者会以为那就是原名，
    // 而服务端只知道 key 长这样。
    assert.doesNotMatch(items[0].note, /文件名/,
      'orphan-object 没有文件名可报 —— key 里那截只是 key 的一部分')
  })

  test('note 不承诺任何原名 / 文件夹 / 大小', () => {
    const [item] = purgeItems(row('[{"key":"u/43/2026-10-01/1_a_%E6%8A%A5%E5%91%8A"}]', {
      kind: 'orphan-object'
    }))
    for (const forbidden of ['文件名', '原属文件夹', '原文件名']) {
      assert.ok(!item.note.includes(forbidden),
        `note 里不该出现「${forbidden}」—— 这份载荷里根本没有这个信息：${item.note}`)
    }
  })

  test('users/ 命名空间的孤儿对象：只有 uuid，同样什么都不许编', () => {
    const [item] = purgeItems(row('[{"key":"users/43/202610/2e6e09be-7646-494c-94d5-e6fefec899c9.cpp"}]', {
      kind: 'orphan-object'
    }))
    assert.equal(item.key, 'users/43/202610/2e6e09be-7646-494c-94d5-e6fefec899c9.cpp')
    assert.doesNotMatch(item.note, /文件名|文件夹/)
  })
})

describe('dangling-row：原文件名和原文件夹必须显示出来', () => {
  // 这一条是用户投诉时唯一拿得出的证据。藏起来 = 这个功能白做。
  const SNAPSHOT =
    '[{"id":27,"fileKey":"users/43/202609/a5909fba-5171-4cc3-9a2b-6ddc7d11983e.cpp",' +
    '"filename":"未命名1.cpp","folderId":127,"fileSize":7932,"createdAt":"2026-09-29 11:08:08"}]'

  test('真库里的那一条：文件名 / 文件夹 / 大小 / 创建时间都在', () => {
    const [item] = purgeItems(row(SNAPSHOT, { kind: 'dangling-row' }))
    assert.equal(item.key, 'users/43/202609/a5909fba-5171-4cc3-9a2b-6ddc7d11983e.cpp')
    assert.match(item.note, /未命名1\.cpp/, '原文件名必须显示 —— 对象已经没了，只剩这里')
    // 原属文件夹是同一等级的证据：用户要知道东西原来在哪，才能去别处找。
    // 少了它，操作者只知道「有个文件被删了」，却不知道该去哪里找那个文件。
    assert.match(item.note, /#127/, '原属文件夹必须显示 —— 用户要知道东西原来在哪')
    // 7.75 KB 是 formatFileSize 的输出，刻意写死：
    // 这一列与孤儿表用同一个格式化器，两处对同一大小显示不同字符串就是 bug
    assert.match(item.note, /7\.75 KB/, '大小要显示，且必须与孤儿表用同一个格式化器')
    assert.match(item.note, /2026-09-29 11:08:08/, '创建时间要显示')
  })

  test('created_at 标了 UTC —— 不标的话看的人会当本地时间', () => {
    const [item] = purgeItems(row(SNAPSHOT, { kind: 'dangling-row' }))
    assert.match(item.note, /UTC/,
      'DB 里存的是 SQLite CURRENT_TIMESTAMP（UTC 墙钟）。这里只展示不换算，' +
      '所以必须标出来，否则 +0800 的看的人会把 11:08 当成本地 11:08，差 8 小时')
  })

  test('缺字段时少显示而不是显示 undefined', () => {
    const [item] = purgeItems(row('[{"fileKey":"users/43/202610/x.bin"}]', { kind: 'dangling-row' }))
    assert.equal(item.key, 'users/43/202610/x.bin')
    assert.doesNotMatch(item.note, /undefined|NaN|null/,
      `不该把缺失字段印出来：${item.note}`)
  })

  test('fileSize 为 0 也要显示（0 是真实值，不是缺失）', () => {
    const [item] = purgeItems(
      row('[{"fileKey":"users/43/202610/x.bin","fileSize":0}]', { kind: 'dangling-row' })
    )
    assert.match(item.note, /0 B/, `0 字节是真实值，不能因为 falsy 就丢掉：${item.note}`)
  })
})

describe('载荷坏掉时如实说，绝不返回空数组', () => {
  // 返回空 = 界面上「这次没删过什么」。而审计的价值恰恰在于「不会空、不会漏」。
  for (const [desc, payload] of [
    ['不是 JSON', '{ 这不是 json'],
    ['空字符串', ''],
    ['截断的 JSON（写到一半崩了）', '[{"key":"u/43/2026-10-01/1_a_'],
    ['JSON null', 'null'],
    ['是对象不是数组', '{"key":"u/43/x"}'],
    ['是数字不是数组', '42']
  ]) {
    test(`${desc} → 产出一条说清状况的条目`, () => {
      const items = purgeItems(row(payload))
      assert.ok(items.length > 0, `${desc}：不能返回空数组 —— 那等于说「没删过东西」`)
      assert.ok(items.some((i) => i.note.length > 0), `${desc}：必须说清发生了什么`)
    })
  }

  test('非 JSON 时用的是可识别的固定文案', () => {
    const [item] = purgeItems(row('{ 坏了'))
    assert.equal(item.note, UNREADABLE_PAYLOAD_NOTE)
  })
})

describe('未知形状逐条报出来，不静默丢弃', () => {
  // 丢一条 = 审计少一条。新增 kind 时这里会显示「未知的载荷形状」，
  // 那正是应该出现的样子 —— 比少一条记录强。
  test('混了认识和不认识的，两条都要在', () => {
    const items = purgeItems(row('[{"key":"u/43/a"},{"futureKind":"???"},{"fileKey":"users/43/b"}]'))
    assert.equal(items.length, 3, '三条输入必须产出三条 —— 丢一条就是审计漏一条')
    assert.match(items[1].note, /未知/)
  })

  test('数组里的 null 元素不炸', () => {
    const items = purgeItems(row('[null,{"key":"u/43/a"}]'))
    assert.equal(items.length, 2)
  })

  test('空数组就是空数组（真的什么都没删，不是坏掉）', () => {
    assert.deepEqual(purgeItems(row('[]')), [],
      'count=0 的删除不该被当成「载荷坏了」—— 两者在界面上要长得不一样')
  })
})
