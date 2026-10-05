// 批量设置分享的**接线**：端点的事务边界 + 前端的门控与提交路径。
//
// ## 分工
//
//   share-bulk-apply.test.mjs   载荷语义的**行为**测试（直接调真函数）
//   本文件                     载荷语义测不到的那部分：谁在什么条件下调它、
//                              事务怎么收口、按钮在哪几处出现
//
// ## 为什么这些只能用源码断言
//
// 两端都碰不到真的运行环境：
//   server/api/share/bulk.post.ts  依赖 Nitro 注入的 defineEventHandler 全局，
//                                   裸 node 里 import 就 ReferenceError
//   app/components/*.vue           项目没有 @vue/test-utils / happy-dom，
//                                   组件挂载后渲染不了
//
// 所以这部分是源码结构断言。它测不出「按钮好不好看」「横幅会不会挡住东西」，
// 那些仍需浏览器里看一眼 —— 这一点写在这里，别把这份测试当成行为保证。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const ENDPOINT = 'server/api/share/bulk.post.ts'
const DIALOG = 'app/components/ShareDialog.vue'
const BROWSER = 'app/components/FileBrowser.vue'
const SERVICE = 'app/services/share.service.ts'
const FILE_TYPES = 'types/files.ts'

/** 去掉注释，免得注释里提到的东西把判定带偏 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

/** 顶层 <template>。嵌套 template（v-for 里的）会让正则非贪婪提前收尾 */
function templateOf(src) {
  const { descriptor, errors } = parse(src, { filename: 'x.vue' })
  assert.equal(errors?.length ?? 0, 0, 'SFC 解析出错 —— 测试的输入本身有问题')
  return codeOnly(descriptor.template?.content ?? '')
}

/** 取顶层 <script setup> 的内容 */
function scriptOf(src) {
  const { descriptor, errors } = parse(src, { filename: 'x.vue' })
  assert.equal(errors?.length ?? 0, 0, 'SFC 解析出错 —— 测试的输入本身有问题')
  return codeOnly(descriptor.scriptSetup?.content ?? '')
}

describe('管理视角：bulk 端点必须认 useAdmin', () => {
  /**
   * 这是「管理页面也能用」这个需求的硬前提。
   *
   * 原来 bulk 端点用的是 requireAuth —— 它只认「我是谁」，读不到
   * useAdmin / targetUserId，于是 ownerId 永远是管理员自己，而分享设置属于
   * 被浏览者，于是每一项都 403。改了不改，管理员在 /manage/files 里批量
   * 设置分享就是全批失败。
   */
  test('用 getMeAndTarget 而不是 requireAuth', () => {
    const src = codeOnly(read(ENDPOINT))
    assert.match(
      src,
      /const \{ authUserId \} = await getMeAndTarget\(event\)/,
      'bulk 端点必须用 getMeAndTarget —— requireAuth 读不到 useAdmin，管理视角下每一项都会 403'
    )
    assert.doesNotMatch(src, /requireAuth\(event\)/, 'requireAuth 不该再出现在这条路径上')
  })

  test('ownerId 取自 authUserId（管理员模式下它就是被浏览者）', () => {
    const src = codeOnly(read(ENDPOINT))
    assert.match(
      src,
      /const ownerId = Number\(authUserId\)/,
      'ownerId 必须来自 authUserId —— 归属校验全靠它'
    )
  })

  test('前端管理视角把 useAdmin / targetUserId 一起发过去', () => {
    const src = codeOnly(read(SERVICE))
    assert.match(
      src,
      /if \(scope\?\.useAdmin && scope\.targetUserId != null\) \{\s*body\.useAdmin = true\s*body\.targetUserId = scope\.targetUserId/,
      'bulkApply 必须透传 useAdmin / targetUserId —— 漏了就是管理员改自己的属主判定，整批 403'
    )
  })
})

describe('每项一个 savepoint：单项原子，跨项隔离', () => {
  test('savepoint 开在循环体内（不是全局一个）', () => {
    const src = codeOnly(read(ENDPOINT))
    const loopAt = src.indexOf('for (const item of rawTargets)')
    assert.ok(loopAt > 0, '没找到逐项循环')
    const savepointAt = src.indexOf("SAVEPOINT bulk_item_tx")
    assert.ok(savepointAt > loopAt, 'savepoint 必须在循环体里 —— 全局一个就把「1 项失败不影响其余」毁掉了')

    const afterLoop = src.slice(src.indexOf('\n  }\n', loopAt))
    assert.doesNotMatch(
      afterLoop,
      /SAVEPOINT bulk_item_tx/,
      '循环之后不该再有 savepoint —— 全局事务会让 200 项绑成一个成败单位'
    )
  })

  test('归属校验（只读）在 savepoint 之前 —— 校验没过就不开事务', () => {
    const src = codeOnly(read(ENDPOINT))
    const resolveAt = src.indexOf('await resolveShareTarget(db, type, id, ownerId)')
    const savepointAt = src.indexOf("SAVEPOINT bulk_item_tx")
    assert.ok(resolveAt > 0 && savepointAt > 0)
    assert.ok(
      resolveAt < savepointAt,
      'resolveShareTarget 是只读的，应该在 savepoint 之前 —— 否则每一项都白开一次事务'
    )
  })

  test('apply 的三处写都在 savepoint 内', () => {
    const src = codeOnly(read(ENDPOINT))
    const start = src.indexOf("SAVEPOINT bulk_item_tx")
    const release = src.indexOf("RELEASE bulk_item_tx")
    const span = src.slice(start, release)
    // applyToTarget 是独立函数，看它有没有三项都写
    const at = src.indexOf('async function applyToTarget')
    const fn = src.slice(at, src.indexOf('\n}', at))
    for (const needle of ['payload.mode !== null', 'payload.isPublic !== null', 'payload.grants !== null']) {
      assert.match(fn, new RegExp(needle.replace(/\./g, '\\.')), `applyToTarget 少了 ${needle}`)
    }
    assert.match(span, /applyToTarget\(db, target, applyPayload!\)/, 'apply 必须在 savepoint 区间内')
  })

  // reset 原来四步裸奔。这里既然有了机制，顺手一起修 —— 同一个 savepoint
  // 开销可忽略，而「三态已改、名单清了一半」的行是没法看的。
  test('reset 的四步也在 savepoint 内（不是半途中断留半套）', () => {
    const src = codeOnly(read(ENDPOINT))
    const start = src.indexOf("SAVEPOINT bulk_item_tx")
    const release = src.indexOf("RELEASE bulk_item_tx")
    const span = src.slice(start, release)
    for (const needle of [
      'setShareMode(db, target, SHARE_INHERIT)',
      'setPublic(db, target, false)',
      'replaceAccess(db, target, [])',
      'deleteShareLinksByTarget(db, type, id, ownerId)'
    ]) {
      assert.ok(span.includes(needle), `reset 的「${needle}」不在 savepoint 区间内`)
    }
  })

  test('收口在 finally 里，由 settled 标志守卫（漏一个出口就整库 BUSY）', () => {
    const src = codeOnly(read(ENDPOINT))
    assert.match(src, /let settled = false/)
    assert.match(
      src,
      /await db\.prepare\('RELEASE bulk_item_tx'\)\.bind\(\)\.run\(\)\s*settled = true/,
      '提交后必须立刻置 settled —— 否则 finally 会把已提交的也回滚掉'
    )
    assert.match(src, /\} finally \{\s*if \(!settled\) \{[\s\S]*?ROLLBACK TO bulk_item_tx/)
    assert.match(
      src,
      /ROLLBACK TO bulk_item_tx[\s\S]{0,200}?RELEASE bulk_item_tx/,
      '回滚后必须 RELEASE —— 只 ROLLBACK TO 的话 savepoint 还挂着，整库写锁不释放'
    )
  })

  test('回滚失败不吞（事务状态不可信时宁可整个请求失败）', () => {
    const src = codeOnly(read(ENDPOINT))
    const finallyAt = src.indexOf('if (!settled)')
    const body = src.slice(finallyAt, finallyAt + 400)
    assert.doesNotMatch(
      body,
      /catch\s*(\(|\{)/,
      '回滚外面不该套 catch —— 吞掉就等于在坏状态上继续处理后面的项'
    )
  })

  // 「逐项隔离」有两个动作：catch 住不抛出，以及**把失败记进 results**。
  // 只断言有 catch 不够 —— 把 catch 整个删掉（错误直接往上抛、整批 500）时，
  // 「有 finally」那条照样成立，但用户一个成功项都拿不到。
  test('单项失败被记录进 results（而不是整批抛出）', () => {
    const src = codeOnly(read(ENDPOINT))
    const tryAt = src.indexOf('try {', src.indexOf('SAVEPOINT bulk_item_tx'))
    const finallyAt = src.indexOf('} finally {', tryAt)
    assert.ok(tryAt > 0 && finallyAt > tryAt, '结构不对：找不到 try / finally')
    const region = src.slice(tryAt, finallyAt)
    assert.match(region, /catch \(e: any\)/, 'savepoint 区间内必须有 catch')
    assert.match(
      region,
      /results\.push\(failure\(type, id, e\)\)/,
      'catch 必须把失败记进 results —— 不记的话用户看不到哪几项没成'
    )
    assert.doesNotMatch(
      region,
      /catch \(e: any\)\s*\{\s*throw/,
      'catch 里不该重新抛出 —— 那会把整批打成 500，前面的成功项白做'
    )
  })

  test('apply 的载荷在循环之前校验（非法载荷一个字节都写不下去）', () => {
    const src = codeOnly(read(ENDPOINT))
    const parseAt = src.indexOf('parseShareBulkApplyPayload(body, ownerId')
    const loopAt = src.indexOf('for (const item of rawTargets)')
    assert.ok(parseAt > 0, '没找到载荷解析')
    assert.ok(parseAt < loopAt, '载荷必须在循环之前校验 —— 放循环里的话前 30 项已经改了才报 400')
  })
})

describe('前端：批量模式的三处行为差异', () => {
  test('isBulk 判 length 而不是判 null（空数组传进来也不该当批量）', () => {
    const src = scriptOf(read(DIALOG))
    assert.match(
      src,
      /const isBulk = computed\(\(\) => \(props\.bulkTargets\?\.length \?\? 0\) > 0\)/,
      'isBulk 必须按 length 判 —— 判 null 的话传个空数组就进了批量分支，界面显示「批量 0 项」'
    )
  })

  test('批量模式不发任何即时请求（三处都提前 return）', () => {
    const src = scriptOf(read(DIALOG))
    // applyMode / applyPublic / submitGrants 三个函数体首行就要有 isBulk 早退
    for (const fn of ['applyMode', 'applyPublic', 'submitGrants']) {
      const at = src.indexOf(`async function ${fn}`)
      assert.ok(at > 0, `没找到 ${fn}`)
      const guard = src.indexOf('if (isBulk.value)', at)
      const call = src.search(/ShareService\.setState\(/g)
      const end = src.indexOf('\n}\n', at)
      const body = src.slice(at, end > 0 ? end : at + 2500)
      assert.match(
        body,
        /if \(isBulk\.value\) \{/,
        `${fn} 在批量模式下必须先早退 —— 点一下就发一次请求 = N 项 × 3 次，中途失败还留半套`
      )
      assert.ok(guard > 0 && guard < (end > 0 ? end : at + 2500), `${fn} 的早退位置不对`)
    }
  })

  test('load 在批量模式下不发请求（没有「某一项的现状」可读）', () => {
    const src = scriptOf(read(DIALOG))
    const at = src.indexOf('async function load()')
    assert.ok(at > 0, '没找到 load')
    // 收尾用**下一个顶层函数声明**做锚点。
    //
    // 第一版写的是 `indexOf('\nasync function close', at)` —— 但 close 不是
    // async，那个 indexOf 返回 -1，`slice(at, -1)` 于是切到了文件末尾，把后面
    // 所有函数都算进来。结果「load 里有 isBulk 早退」这条被 applyMode 里的同名
    // 片段满足了，而把 load 里那个 if 换成 if (false) 也照样全绿。
    const nextFn = src.indexOf('\nfunction ', at + 10)
    assert.ok(nextFn > at, '没找到 load 之后的下一个函数声明')
    const body = src.slice(at, nextFn)

    assert.match(body, /if \(isBulk\.value\) \{[\s\S]*?\n    return\n/, '批量模式必须跳过 load')
    assert.match(
      body,
      /mode\.value = SHARE_INHERIT/,
      '批量初值必须是「继承」—— 用户选定的语义：批量是写入目标，不是浏览'
    )
    assert.match(body, /grants\.value = \[\]/, '批量初值名单必须为空')
    // 而单项路径仍要真的读一次
    assert.match(body, /ShareService\.list\(scope\.value\)/, '单项模式仍要读现状')
  })

  test('链接区整块隐藏（批量不生成链接）', () => {
    const tpl = templateOf(read(DIALOG))
    assert.match(
      tpl,
      /<div v-if="!isBulk" class="mt-5 border-t border-gray-100 pt-4">/,
      '链接区必须 v-if="!isBulk" —— N 项就是 N 条链接，弹窗里分不出彼此'
    )
    // 生成链接 / 撤销链接两个按钮都不能在批量模式可达
    const bulkGuard = tpl.indexOf('v-if="!isBulk"')
    const addLink = tpl.indexOf('@click="addLink"')
    const removeLink = tpl.indexOf('@click="removeLink(l)"')
    assert.ok(bulkGuard >= 0 && addLink > bulkGuard, '「生成链接」必须落在 v-if="!isBulk" 之内')
    assert.ok(removeLink > bulkGuard, '「撤销链接」必须落在 v-if="!isBulk" 之内')
  })
})

describe('覆盖语义必须被说清楚', () => {
  test('应用前 confirm，且文案写明「覆盖，不是合并」', () => {
    const src = scriptOf(read(DIALOG))
    const at = src.indexOf('async function applyToTargets')
    const body = src.slice(at, src.indexOf('\nasync function', at + 10))
    assert.match(body, /window\.confirm\(/, '提交前必须 confirm —— 批量是整体复写，误点代价很大')
    assert.match(body, /覆盖，不是合并/, 'confirm 文案必须点明覆盖语义')
  })

  // 「初值全空」+「留空即清空」叠起来 = 什么都不改直接提交 = 批量 reset。
  // 没有这条横幅，用户不会想到自己的授权会被清掉。
  test('有东西会被清掉时才显示警告横幅（没破坏就不显示）', () => {
    const src = scriptOf(read(DIALOG))
    assert.match(
      src,
      /const bulkWipeNotes = computed<string\[\]>\(\(\) => \{[\s\S]*?if \(s\.withGrants > 0\)/,
      '必须有 bulkWipeNotes —— 提交前要让用户看见「会被毁掉什么」'
    )
    assert.match(src, /if \(s\.isPublicCount > 0\)/, '要提示公开会被关掉')
    assert.match(src, /if \(s\.notInherit > 0\)/, '要提示非继承三态会被压平')
    const tpl = templateOf(read(DIALOG))
    assert.match(
      tpl,
      /v-if="isBulk && bulkWipeNotes\.length"/,
      '横幅的条件必须是「有东西会被毁掉」—— 空横幅比没有更糟'
    )
  })

  test('判三态走 normalizeShareMode，不许自己比 === 1', () => {
    const src = scriptOf(read(DIALOG))
    const at = src.indexOf('const bulkCurrentSummary = computed')
    const body = src.slice(at, src.indexOf('const bulkWipeNotes', at))
    assert.match(
      body,
      /normalizeShareMode\(t\.Shared\)/,
      '必须用 normalizeShareMode —— Number(true) === 1 === SHARE_SHARED，' +
        '自己写 === 1 会把「继承」算成「分享」'
    )
  })

  test('提交结果按 okCount / failCount 汇总，失败原因去重', () => {
    const src = scriptOf(read(DIALOG))
    const at = src.indexOf('async function applyToTargets')
    const body = src.slice(at, src.indexOf('\nasync function', at + 10))
    assert.match(body, /res\.failCount === 0/, '必须区分全成功与部分失败')
    assert.match(body, /res\.okCount/)
    assert.match(body, /new Set\(/, '失败原因要去重 —— 20 项同一条原因印 20 遍没有信息量')
  })

  test('部分失败也要刷新界面（成功那几项的角标已经过期）', () => {
    const src = scriptOf(read(DIALOG))
    const at = src.indexOf('async function applyToTargets')
    assert.ok(at > 0, '没找到 applyToTargets')
    const end = src.indexOf('\nasync function', at + 10)
    const body = src.slice(at, end > 0 ? end : src.length)

    assert.ok(body.includes("emit('changed')"), '成功之后必须 emit changed')
    // 关键是「emit changed 前面没有成败守卫」。
    //
    // 第一版写的是「emit 的位置在 failCount 之后」—— 而正确写法与
    // `if (res.failCount === 0) emit('changed')` 恰好都是「failCount 在前、
    // emit 在后」，两者位置关系一样，于是那条把刷新收进成功分支的变异溜过去了。
    // 语义完全相反的两种写法，位置关系却相同 —— 所以只能断言「没有守卫」。
    const emitAt = body.indexOf("emit('changed')")
    const before = body.slice(Math.max(0, emitAt - 60), emitAt)
    assert.doesNotMatch(
      before,
      /failCount\s*===?\s*0\s*\)?.{0,40}$/,
      `emit changed 前面有成败守卫 —— 部分失败时成功的那几项界面留着过期状态。实际前缀：\n${before}`
    )
    assert.doesNotMatch(
      body,
      /if \(res\.failCount === 0\)[^\n]*emit\('changed'\)/,
      'emit changed 必须在成败分支之外'
    )
  })
})

describe('按钮的准入与角标共用一个判据', () => {
  test('canBulkShare 是一个 computed，同时喂角标与按钮', () => {
    const tpl = templateOf(read(BROWSER))
    const src = scriptOf(read(BROWSER))
    assert.match(
      src,
      /const canBulkShare = computed\(\(\) => isOwn\.value && !linkMode\.value\)/,
      'canBulkShare 必须是独立 computed'
    )
    assert.match(
      tpl,
      /:show-share-badge="canBulkShare"/,
      '角标要绑 canBulkShare —— 分两处写就是给「改一处忘一处」留口子'
    )
  })

  test('canBulkShare 排除了 shared 视角与链接视角', () => {
    const src = scriptOf(read(BROWSER))
    const at = src.indexOf('const canBulkShare = computed')
    const body = src.slice(at, src.indexOf('\n', at + 30))
    assert.match(body, /isOwn\.value/, '必须要求 own —— shared 视角下那些是别人的内容，我无权改它的分享')
    assert.match(body, /!linkMode\.value/, '必须排除链接视角 —— 条目属主是别人，访客也没有身份')
  })

  test('三处入口都在（桌面工具栏 / 移动端底部条 / 移动端更多菜单）', () => {
    const tpl = templateOf(read(BROWSER))
    // 「更多」菜单那一处的点击是 `@click="openBulkShare(); mobileMoreOpen = false"` ——
    // 所以匹配到 `openBulkShare` 为止，不能带收尾引号（第一版带了，只数出 2 处，
    // 差点以为真少了一处）。
    const buttons = [...tpl.matchAll(/<button[^>]*v-if="canBulkShare"[^>]*@click="openBulkShare/g)]
    assert.equal(
      buttons.length,
      3,
      `分享按钮应出现 3 处（桌面工具栏、移动端底部条、移动端「更多」菜单），实际 ${buttons.length} 处`
    )
    // 每一处都必须同时禁用「未选中」
    for (const m of buttons) {
      assert.match(m[0], /:disabled="selectedCount === 0"/, '每一处都要在未选中时禁用')
    }
  })

  test('ShareIcon 已导入（否则三处按钮都渲染不出图标）', () => {
    const src = codeOnly(read(BROWSER))
    assert.match(src, /import \{[\s\S]*?ShareIcon,[\s\S]*?\} from '@heroicons\/vue\/24\/outline'/)
  })

  test('共享同一个 ref 对（单项与批量互斥，不会同时开）', () => {
    const src = scriptOf(read(BROWSER))
    assert.match(
      src,
      /const openBulkShare = \(\) => \{[\s\S]*?shareTarget\.value = null[\s\S]*?bulkShareOpen\.value = true/,
      '打开批量时要关掉单项 —— 两个 ShareDialog 实例各持状态，同时开着只会看得见一个'
    )
    const tpl = templateOf(read(BROWSER))
    assert.match(tpl, /:open="bulkShareOpen"/, '第二个实例绑 bulkShareOpen')
    assert.match(tpl, /:bulk-targets="bulkShareTargets"/, '第二个实例传 bulkTargets')
    // 不要加 v-if：会让离场动画一帧都不播
    assert.doesNotMatch(
      tpl,
      /<ShareDialog\s+v-if/,
      'ShareDialog 不能加 v-if —— 内部 Transition 靠 :open 驱动，摘出 vdom 就没有离场动画'
    )
  })

  test('每项带上当前状态，供覆盖警告用（数据 /api/files 已返回）', () => {
    const src = scriptOf(read(BROWSER))
    // **数个数**，不能只 match 一次。
    // 第一版写的是 `assert.match(src, /Shared: f\.Shared/)` —— 文件夹那处被改坏
    // （Shared: undefined）时，文件那处照样匹配，断言全绿。真正要守的是两处都在。
    assert.equal(
      [...src.matchAll(/Shared: f\.Shared/g)].length,
      2,
      '文件夹与文件两处都要带 Shared —— 少一处，那一类项的覆盖警告就看不到现状'
    )
    assert.equal([...src.matchAll(/IsPublic: f\.IsPublic/g)].length, 2, 'IsPublic 两处都要带')
    assert.match(src, /grantCount: \(f as FileListFolder\)\.grantCount/)
    assert.match(src, /grantCount: \(f as FileListFile\)\.grantCount/)
    // 文件夹与文件一起交，不替用户挑
    assert.match(src, /targetType: 'folder'/)
    assert.match(src, /targetType: 'file'/)
  })
})

describe('类型：三态是数字，不是布尔', () => {
  /**
   * 原来写的是 `Shared?: boolean`，与 schema 的 `Shared INTEGER` 不符。
   *
   * `Number(true) === 1 === SHARE_SHARED` —— 谁写 `Number(x.Shared)` 去判三态，
   * 「继承」就会被算成「分享」，凭空立一道墙把上层共享的其他人全挡掉。
   */
  test('FileRecord.Shared 与 FolderRecord.Shared 都是 number', () => {
    const src = read(FILE_TYPES)
    for (const name of ['FileRecord', 'FolderRecord']) {
      const at = src.indexOf(`export interface ${name}`)
      assert.ok(at > 0, `没找到 ${name}`)
      const body = src.slice(at, src.indexOf('\n}', at))
      assert.match(
        body,
        /Shared\?:\s*number/,
        `${name}.Shared 必须是 number —— 写成 boolean 会让 Number(true) === SHARE_SHARED`
      )
      assert.doesNotMatch(body, /Shared\?:\s*boolean/, `${name}.Shared 不该是 boolean`)
    }
  })

  test('前端服务层的批量载荷复用同一个 ShareMode（不另开一个 number）', () => {
    const src = codeOnly(read(SERVICE))
    assert.match(src, /mode\?: ShareMode \| null/, '载荷的 mode 必须是 ShareMode，别用裸 number')
    assert.match(src, /grants\?: Array<\{ userId: number; permission: number \}> \| null/)
  })

  test('apply 不在分享管理页的按钮文案表里（它不是按钮，是打开弹窗）', () => {
    const src = codeOnly(read(SERVICE))
    assert.match(
      src,
      /export const SHARE_BULK_ACTION_LABELS: Record<Exclude<ShareBulkAction, 'apply'>, string>/,
      'apply 没有按钮文案，不该出现在那张表里'
    )
    // 而 bulk() 只收前三个
    assert.match(
      src,
      /action: Exclude<ShareBulkAction, 'apply'>/,
      'bulk() 不该接受 apply —— apply 的载荷形状完全不同，塞进同一个签名里迟早被搞混'
    )
  })
})