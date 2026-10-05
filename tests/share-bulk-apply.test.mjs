// 批量设置的载荷语义 —— server/utils/share-bulk-apply.ts。
//
// ## 为什么这是抽出来的模块而不是端点里的私有函数
//
// 「undefined = 不碰，[] = 清空」这条语义，用源码正则断言是测不准的：正则能
// 看出「有 hasGrants 这个变量」，看不出「空数组走的是另一条分支」。
//
// 而这条语义退化的后果很具体：有人图省事把两者合成同一个值，于是「只改三态」
// 顺手把所有人从名单里抹了，界面上完全看不出来。所以它必须被行为测试钉住 ——
// 这与当初把并发池抽成 server/utils/concurrency.ts 是同一个理由
// （闭包内的东西只能「同构复刻」测试，测的不是被跑的那份）。
//
// ## 这个模块不依赖 db
//
// assertGrantees 的第一个形参是 db，这里通过注入绕开，于是测它不用起库。
// 真函数在 server/utils/share.ts，调用点把 db 闭包进去。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// 挂 ~~/ 别名，好让被测模块能 import 到 types/share。
// 用法与 sub-account-quota.test.mjs 一致：直接 register hook 本身，
// 不是那个 helper 的具名导出（它没有具名导出，只有副作用）。
register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

/**
 * createError 是 Nitro 注入的全局。模块只在「三字段全空」那条路上用到它，
 * 而那条路正是要测的 —— 所以先给它一个替身，形状与 h3 一致
 * （抛出的对象带 statusCode 与 message，handler 上层会读这两个字段）。
 *
 * 必须在 import 之前赋值：模块顶层不引用它，但函数体在调用时才查全局，
 * 所以其实晚一点也行 —— 放前面是为了不让「忘了定义」这件事推迟到运行时才发现。
 */
globalThis.createError = (input) => {
  const err = new Error(input?.message ?? 'error')
  err.statusCode = input?.statusCode ?? 500
  return err
}

const { parseShareBulkApplyPayload } = await import('../server/utils/share-bulk-apply.ts')

const { SHARE_NONE, SHARE_SHARED, SHARE_INHERIT, PERM_ALL, PERM_READ } = await import('../types/share.ts')

const OWNER = 7

/** 记录被调用了几次 —— 「只查一次」是本文件要钉的性能与正确性约束 */
function makeDeps(overrides = {}) {
  const calls = { assertGrantees: 0, ids: [] }
  const deps = {
    calls,
    assertGrantees: async (userIds, ownerId) => {
      calls.assertGrantees++
      calls.ids.push(...userIds)
      if (ownerId !== OWNER) throw new Error(`ownerId 传错：${ownerId}`)
      // 去重，形态与真函数一致
      return [...new Set(userIds)]
    },
    assertPermissionBits: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) throw new Error('非法的 permission')
      if (n & ~PERM_ALL) throw new Error('permission 含未定义的权限位')
      return n
    },
    ...overrides
  }
  return deps
}

const parse = (body, deps = makeDeps()) => parseShareBulkApplyPayload(body, OWNER, deps)

describe('载荷语义：传了才改，不传就是不改', () => {
  test('只给 mode：另两个字段是 null（不碰）', async () => {
    const deps = makeDeps()
    const p = await parse({ mode: SHARE_SHARED }, deps)
    assert.equal(p.mode, SHARE_SHARED)
    assert.equal(p.isPublic, null, '没传 isPublic 就不该是 false —— 那会把所有项的公开关掉')
    assert.equal(p.grants, null, '没传 grants 就不该是 [] —— 那会清空所有人的授权')
    assert.equal(deps.calls.assertGrantees, 0, '没传名单就不该去查库')
  })

  test('只给 grants：mode / isPublic 都是 null', async () => {
    const p = await parse({ grants: [{ userId: 3, permission: PERM_READ }] })
    assert.equal(p.mode, null)
    assert.equal(p.isPublic, null)
    assert.deepEqual(p.grants, [{ userId: 3, permission: PERM_READ }])
  })

  // 这条是整个文件的核心。两者在 JS 里都「像是空的」，合成一个值的后果是
  // 「只改三态」顺手抹掉所有授权，而界面上完全看不出来。
  test('undefined 与 null 都是「不碰」，空数组是「清空」', async () => {
    const a = await parse({ mode: SHARE_SHARED, grants: undefined })
    assert.equal(a.grants, null, 'undefined = 不碰')

    const b = await parse({ mode: SHARE_SHARED, grants: null })
    assert.equal(b.grants, null, 'null = 不碰')

    const c = await parse({ mode: SHARE_SHARED, grants: [] })
    assert.deepEqual(c.grants, [], '[] = 清空，与上面两个不是一回事')
  })

  test('非数组的 grants 当空数组（清空），不当「不碰」', async () => {
    // 「传了但形状不对」必须落在「清空」上，不能悄悄变成「不碰」——
    // 后者会让用户的明确意图消失，而界面还显示「已清空」。
    for (const bad of [{}, 'abc', 42, true]) {
      const p = await parse({ grants: bad })
      assert.deepEqual(p.grants, [], `grants=${JSON.stringify(bad)} 应按空名单处理`)
    }
  })

  test('三字段全缺 → 400（不能静默变成空操作）', async () => {
    for (const body of [{}, { mode: null }, { isPublic: null, grants: null }, { foo: 1 }]) {
      await assert.rejects(
        () => parse(body),
        (e) => /至少要指定/.test(e?.message ?? ''),
        `${JSON.stringify(body)} 应当报错`
      )
    }
  })
})

describe('三态的归一：必须走 normalizeShareMode', () => {
  test('0/1/2 映射到自身', async () => {
    for (const [input, want] of [[SHARE_NONE, SHARE_NONE], [SHARE_SHARED, SHARE_SHARED], [SHARE_INHERIT, SHARE_INHERIT]]) {
      assert.equal((await parse({ mode: input })).mode, want)
    }
  })

  test('字符串数字按数值判定', async () => {
    assert.equal((await parse({ mode: '1' })).mode, SHARE_SHARED)
    assert.equal((await parse({ mode: '0' })).mode, SHARE_NONE)
  })

  // Number(true) === 1 === SHARE_SHARED。没有守卫的话「继承」会被算成「分享」，
  // 于是用户在一个继承节点上凭空立了一道边界，把上层共享的其他人全挡掉。
  test('布尔与对象退回继承（绝不凭空立墙）', async () => {
    for (const Shared of [true, false, [], [0], [1], {}, [2]]) {
      assert.equal(
        (await parse({ mode: Shared })).mode,
        SHARE_INHERIT,
        `mode=${JSON.stringify(Shared)} 应退回继承`
      )
    }
  })

  test('脏数字也退回继承', async () => {
    for (const m of [99, -1, 'abc']) {
      assert.equal((await parse({ mode: m })).mode, SHARE_INHERIT)
    }
  })
})

describe('公开标志：严格真布尔', () => {
  test('true / 1 都算公开', async () => {
    assert.equal((await parse({ isPublic: true })).isPublic, true)
    assert.equal((await parse({ isPublic: 1 })).isPublic, true)
  })

  // 与 resolveShareBadge 的 `IsPublic === true` 同一口径：数据流上服务端已归一，
  // 万一哪天漏了归一，'true' 与 1 也不该被当成公开。
  test("'true' / 数字 2 / '1' 都不算公开", async () => {
    for (const v of ['true', 2, '1', [], {}]) {
      assert.equal((await parse({ isPublic: v })).isPublic, false, `isPublic=${JSON.stringify(v)}`)
    }
  })

  test('false / 0 都是不公开', async () => {
    assert.equal((await parse({ isPublic: false })).isPublic, false)
    assert.equal((await parse({ isPublic: 0 })).isPublic, false)
  })
})

describe('名单：校验、覆盖、以及「只查一次」', () => {
  test('非空名单去重，且按 assertGrantees 返回的顺序重建', async () => {
    const deps = makeDeps()
    const p = await parse(
      {
        grants: [
          { userId: 5, permission: PERM_READ },
          { userId: 5, permission: PERM_ALL }, // 同一人两次：后一次为准
          { userId: 2, permission: PERM_READ }
        ]
      },
      deps
    )
    assert.deepEqual(p.grants, [
      { userId: 5, permission: PERM_ALL },
      { userId: 2, permission: PERM_READ }
    ])
  })

  // 200 项就是 200 次重复查库。
  test('assertGrantees 只被调用一次（与目标数无关）', async () => {
    const deps = makeDeps()
    await parseShareBulkApplyPayload({ grants: [{ userId: 9, permission: PERM_READ }] }, OWNER, deps)
    assert.equal(deps.calls.assertGrantees, 1)
    assert.deepEqual(deps.calls.ids, [9], '属主校验要拿到完整名单')
  })

  test('空名单不查库（assertGrantees 要求至少一个人，清空是合法意图）', async () => {
    const deps = makeDeps()
    const p = await parse({ grants: [] }, deps)
    assert.deepEqual(p.grants, [])
    assert.equal(deps.calls.assertGrantees, 0)
  })

  test('非法 permission 直接报错，不落到 replaceAccess 才崩', async () => {
    for (const permission of [0, -1, 16, 99, null, undefined, 'x']) {
      await assert.rejects(
        () => parse({ grants: [{ userId: 3, permission }] }),
        /permission/,
        `permission=${JSON.stringify(permission)} 应当被拒`
      )
    }
  })

  test('属主本人进名单会被拒（由 assertGrantees 那一步）', async () => {
    const deps = makeDeps({
      assertGrantees: async () => {
        throw new Error('不能授权给属主本人')
      }
    })
    await assert.rejects(() => parse({ grants: [{ userId: OWNER, permission: PERM_READ }] }, deps), /属主本人/)
  })

  test('条目缺 userId → NaN 进不了名单（由查库那一步拒）', async () => {
    const deps = makeDeps({
      // 真函数会对 NaN 报错：uniqPositiveInts 会把它滤掉，然后 missing 里出现 NaN
      assertGrantees: async (ids) => {
        if (ids.some((i) => !Number.isInteger(i))) throw new Error('用户不存在：NaN')
        return ids
      }
    })
    await assert.rejects(() => parse({ grants: [{ permission: PERM_READ }] }, deps), /用户不存在/)
  })
})