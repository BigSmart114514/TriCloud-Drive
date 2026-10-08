// key 构造器（server/utils/file-key.ts 的 buildUserFileKey / extensionFromFilename）。
//
// ## 为什么这次统一之后必须有这个测试
//
// 统一之前有**两份**实现，各自内联：
//   upload/credentials.post.ts  `users/<id>/<YYYYMM>/<uuid>${substring(lastIndexOf('.'))}`
//   copy/paste.post.ts          `u/<id>/<YYYY-MM-DD>/<ts>_<rand>_<原名>`
//
// 它们能分叉两年没人发现，因为按文件写的断言只看一个文件。现在合成一个函数，
// 它的行为就成了唯一的关口 —— 而且它新引入了 basename 规则，那条规则错了
// 不会报错，只会把原名的一截当成扩展名塞进 key（下面 `../../etc/passwd` 那条
// 就是我写第一版时真的踩到的）。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// **必须固定 TZ，而且必须是非 UTC 的。**
//
// 变异扫描抓到过一条漏网：把 `getUTCFullYear` 改成 `getFullYear` 套件照样全绿。
// 原因是我注入的时间是 `2026-10-08T12:00Z`，在 +0800 下本地也是 10 月 8 日 ——
// 同一时刻的两种读法结果一样，于是那条断言分辨不出来。
//
// 所以这里钉一个跨年边界的时刻：UTC 还是 2025-12，而 +0800 已经是 2026-01。
// getUTC 与 get 的差别在这个时刻是可见的。
//
// 与 tests/server-time.test.mjs 同一个理由（那边是服务端时间，这里是 key 分区）。
process.env.TZ = 'Asia/Shanghai'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { buildUserFileKey, extensionFromFilename, ACTIVE_KEY_PREFIX, fileKeyOwnerId, fileKeyBelongsTo } =
  await import('../server/utils/file-key.ts')

/** 固定时间，2026-10 是 10 月 —— 顺便盯住 padStart 那个 11 月/1 月的边界 */
const OCT = new Date('2026-10-08T12:00:00Z')
const JAN = new Date('2026-01-31T23:59:59Z')

/**
 * 跨年边界：UTC 还是 2025 年 12 月，而 Asia/Shanghai 已经是 2026 年 1 月。
 *
 * 分区必须按 UTC 算 —— 服务器时区不是 UTC 时，跨月/跨年边界会把同一批文件
 * 分到相邻桶里（本地 1/1 凌晨 = UTC 前一天）。而这条时刻正是那种情形。
 */
const NEW_YEAR_UTC_STILL_DEC = new Date('2025-12-31T20:00:00Z')

describe('形状：users/<id>/<YYYYMM>/<uuid><ext>', () => {
  test('整体形状', () => {
    const key = buildUserFileKey(43, '报告.pdf', OCT)
    assert.match(key, /^users\/43\/202610\/[0-9a-f-]{36}\.pdf$/,
      `实际 ${key} —— 前缀、属主、月份分区、uuid、扩展名五段都要在`)
  })

  test('前缀来自 ACTIVE_KEY_PREFIX，不是散落的字面量', () => {
    assert.equal(ACTIVE_KEY_PREFIX, 'users')
    assert.ok(buildUserFileKey(1, 'a.txt', OCT).startsWith(`${ACTIVE_KEY_PREFIX}/`))
  })

  // 统一的核心诉求：复制与上传产出同一种形状。
  test('原名一个字都不进 key（这是这次统一的全部意义）', () => {
    // 只用多字的中文片段。单字母不能用：uuid 是十六进制 + 连字符，
    // 而十六进制里就有 a–f，拿单字母去断言「key 里没有它」是拿随机性当判据。
    // 数字片段要挑不会与分区撞的 —— 第一版拿 `2026` 去断言，结果匹配到的是
    // 分区里的年份 `202610`，报了个查不出真相的失败。
    // 扩展名（.cpp/.xlsx/.gz）**该**出现在 key 里，所以不在断言范围内。
    const cases = [
      ['未命名1.cpp', ['未命名']],
      ['季度总结.xlsx', ['季度', '总结']],
      ['预算-8842表.xlsx', ['预算', '8842']],
      ['a.tar.gz', ['tar']],
      ['x', []]
    ]
    for (const [name, frags] of cases) {
      const key = buildUserFileKey(43, name, OCT)
      for (const frag of frags) {
        assert.ok(!key.includes(frag), `${name} → ${key}：原名的一截「${frag}」进了 key`)
      }
    }
  })

  test('同名文件靠 uuid 区分，不靠名字（所以名字不进 key 也不丢信息）', () => {
    const a = buildUserFileKey(43, '同一个名字.txt', OCT)
    const b = buildUserFileKey(43, '同一个名字.txt', OCT)
    assert.notEqual(a, b)
    // 两者形状完全相同 —— 名字没进 key，所以区分它们的是 uuid 而不是别的
    assert.equal(a.replace(/[0-9a-f-]{36}/, 'U'), b.replace(/[0-9a-f-]{36}/, 'U'))
  })

  test('每次调用都是不同的 uuid（不会撞车）', () => {
    const keys = new Set(Array.from({ length: 200 }, () => buildUserFileKey(43, 'same.txt', OCT)))
    assert.equal(keys.size, 200, 'uuid 必须每次不同 —— 同名文件同分区同目录全靠它区分')
  })

  test('属主判定认得自己产出的 key', () => {
    // 这是安全边界：assertFileKeyOwner 靠它。构造器与判定器必须同源理解前缀。
    for (const id of [1, 2, 43, 999999]) {
      const key = buildUserFileKey(id, 'a.txt', OCT)
      assert.equal(fileKeyOwnerId(key), id, `${key} 解析不出属主 ${id}`)
      assert.equal(fileKeyBelongsTo(key, id), true)
      assert.equal(fileKeyBelongsTo(key, id + 1), false, '不能认成别人的')
    }
  })
})

describe('分区用 UTC，跨年边界也要对', () => {
  test('10 月 → 202610', () => {
    assert.match(buildUserFileKey(1, 'a.txt', OCT), /\/202610\//)
  })

  // 服务器时区不是 UTC 时，月末/年末边界会把同一批文件分到相邻桶里
  // （本地 1/1 凌晨 = UTC 前一天）。这在 1 月最危险：12 月落到前一年。
  test('1 月 31 日 23:59 UTC → 202601（不是 202512）', () => {
    assert.match(buildUserFileKey(1, 'a.txt', JAN), /\/202601\//)
  })

  test('月份是两位数，1 月不能写成 1', () => {
    assert.match(buildUserFileKey(1, 'a.txt', JAN), /\/202601\//, '月份必须 padStart(2, "0")')
  })

  test('now 可以注入（迁移脚本与测试要固定时间）', () => {
    const a = buildUserFileKey(1, 'a.txt', OCT)
    const b = buildUserFileKey(1, 'a.txt', OCT)
    assert.equal(a.slice(0, 'users/1/202610/'.length), b.slice(0, 'users/1/202610/'.length))
  })

  // ★ 变异扫描抓到过这条漏网：getUTCFullYear → getFullYear 套件全绿，
  // 因为当时注入的时刻在两种读法下渲染相同。这条用的时刻跨年，两种读法可见地不同。
  test('跨年边界按 UTC 算（本地已经是 2026-01，UTC 还是 2025-12）', () => {
    const key = buildUserFileKey(1, 'a.txt', NEW_YEAR_UTC_STILL_DEC)
    assert.match(key, /\/202512\//,
      `实际 ${key} —— 必须落在 UTC 那一侧。按本地算会得到 202601，` +
      `于是本地 1/1 凌晨上传的文件会落进上一个月的桶`)
  })

  test('确认这个时刻在本地时区下确实跨年了（否则上面那条是空断言）', () => {
    // 守卫本身的自检：不确认环境真的让两种读法不同，上面那条就分辨不出对错
    const d = NEW_YEAR_UTC_STILL_DEC
    assert.notEqual(
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`,
      `TZ=${process.env.TZ} 下这个时刻的 UTC 与本地月份相同 —— ` +
      `换 TZ 或换时刻，否则「按 UTC 算」那条就恒成立`
    )
  })
})

describe('extensionFromFilename：扩展名是唯一从文件名取的东西', () => {
  test('正常情况', () => {
    assert.equal(extensionFromFilename('报告.pdf'), '.pdf')
    assert.equal(extensionFromFilename('a.tar.gz'), '.gz', '只取最后一段')
    assert.equal(extensionFromFilename('PHOTO.JPG'), '.jpg', '小写化')
    assert.equal(extensionFromFilename('v1.2.3'), '.3')
  })

  test('没有扩展名 → 空串', () => {
    for (const n of ['README', '报告', 'a', '']) {
      assert.equal(extensionFromFilename(n), '', `${n} 不该有扩展名`)
    }
  })

  test('点在最后（x.）→ 空串', () => {
    assert.equal(extensionFromFilename('x.'), '', '尾点不算扩展名')
  })

  test('点开头（.bashrc）→ 空串', () => {
    // 整个串就是扩展名的话，`<uuid>.bashrc` 虽然无害，但语义上那是名字不是扩展名
    assert.equal(extensionFromFilename('.bashrc'), '', '.bashrc 是隐藏文件，不是「无扩展名」')
  })

  test('非字符串 → 空串而不是抛', () => {
    for (const n of [null, undefined, 123, {}, []]) {
      assert.equal(extensionFromFilename(n), '', `${JSON.stringify(n)} 不该抛`)
    }
  })

  // ★ 第一版真的踩到这条：按整个串找最后一个点，`../../etc/passwd` 的
  // 「扩展名」会变成 etcpasswd —— 原名的一截就这么进了 key。不报错、不越权，
  // 只是违背「原名不进 key」，所以几乎不可能被别人发现。
  test('先取 basename 再找点（路径不参与扩展名判定）', () => {
    assert.equal(extensionFromFilename('../../etc/passwd'), '',
      'basename 是 `passwd`，没有点 → 不该有扩展名')
    assert.equal(extensionFromFilename('a.b/c'), '', 'basename 是 `c`')
    assert.equal(extensionFromFilename('dir.v2/photo.png'), '.png', 'basename 的扩展名')
  })

  test('扩展名只留字母数字，长度封顶', () => {
    assert.equal(extensionFromFilename('x.p!@#g'), '.pg', '非字母数字剥掉')
    assert.equal(extensionFromFilename('x.' + 'a'.repeat(40)), '.aaaaaaaaaaaaaaaa',
      '超长扩展名必须截断 —— 否则 key 的末段长度不受控')
  })

  test('扩展名绝不含 / 或路径成分', () => {
    for (const n of ['a.b/c.d', 'x./y', 'a/b.c/d']) {
      const ext = extensionFromFilename(n)
      assert.ok(!ext.includes('/'), `${n} → ${ext}：扩展名里不能有 /`)
    }
  })
})
