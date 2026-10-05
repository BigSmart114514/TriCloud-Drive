// 批量处置分享设置。分享管理页与「我的文件 / 文件总览」页的批量按钮走这里。
//
// ## 四个动作
//
//   reset       恢复默认：三态→继承 + 取消公开 + 清空授权名单 + 撤销全部链接
//   unpublish   取消公开：只动 IsPublic，名单和三态保留
//   removeLinks 撤销链接：只撤链接，别的都不动（最常忘的就是这个）
//   apply       把一份分享设置（mode / isPublic / grants）**整体复写**给每一项
//
// **reset 为什么必须连带撤链**：撤链之后这一项四个条件全不满足，它才会从
// 列表里消失。留着链接的话点完「恢复默认」，那一行还躺在页面上，
// 用户会以为没生效 —— 而实际上「有链接」本身就是一项非默认设置。
//
// 为什么没有第五个「只把三态设成继承」：那个动作点完，名单和链接都还在，
// 条目照样不出列表，语义上等于「没恢复」。而它真正对应的场景
// （我要停止当挡板但保留名单）在分享弹窗里改三态两下就够，
// 批量条只放语义明确、点了就能看出结果的处置。
//
// ## apply 的语义：整体复写，且字段可选
//
// 与 /api/share/mode 同一套 —— 三个字段都可选，只传要改的；`grants` 传空数组
// = 清空名单。**不是**合并：传什么就是最终名单，不在列表里的人会被移除。
//
// 这意味着「什么都不改、只传 mode」不会碰名单，而「传了空名单」就是把名单清空。
// 两者在协议上必须分得清清楚楚，所以用 `undefined`/null 表示「不碰」，
// 而不是用「空数组」表示 —— 空数组是一个明确的、要做的事。
//
// ## apply 的载荷先校验、再逐项执行
//
// grants 的存在性与 permission 位在**进循环之前**一次校验完，
// 不在每项里重跑。200 项就是 200 次重复查库，而且中途才发现载荷非法的话，
// 前面那些项已经被改过了 —— 用户看到的是「一半改了」，却收到一个 400。
//
// 归属仍然逐项校验（见下），因为那是「这一项合不合法」，与载荷无关。
//
// ## 归属校验逐项做，且与 /api/share/mode 同一口径
//
// 传一串 id 进来，就意味着可以传**别人的** id。每一项都过
// resolveShareTarget（属主才放行），失败的那项单独记失败，不影响其余。
// 这是「批量」最容易出的洞：整体校验通过就以为每项都合法了。
//
// ## 每项一个 savepoint
//
// apply 要写三处（mode / IsPublic / 名单），reset 要写四处。任何一步失败，
// 那一项必须回到「什么都没改」，不能停在半套 —— 比如三态已改成「分享」、
// 名单清了一半，那种行是没法看的。
//
// 关键在于**按项开**，不是全局一个：全局事务会把「1 项失败不影响其余 19 项」
// 这条设计毁掉（用户勾了 20 项，其中 1 项被并发删掉，不该让另外 19 项白做）。
// 按项开就是「单项原子 + 跨项隔离」。
//
// resolveShareTarget 是**读**，放在 savepoint 之前 —— 校验没过就不必开事务。
//
// ## 收口唯一化：try/finally
//
// 「有哪些出口」是随代码变的东西，手写清单一定会漏；漏掉的后果不是少回滚
// 一点，而是 savepoint 悬着、整库写锁不释放（见 fd973be，那是 paste 的教训）。
// finally + settled 标志是语言层面的保证。
//
// 回滚失败时**不吞**：事务状态已经不可信，继续处理后面的项等于在坏状态上
// 叠加。宁可整个请求 500，也不要假装后面那些项成功了。
//
// ## 串行执行
//
// 同一个 sqlite3 handle 并发跑语句会让本机原生绑定崩（项目硬约束）。
// 目标数有上限（MAX_TARGETS），串行也不会让请求拖太久。

import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import {
  assertGrantees,
  assertPermissionBits,
  assertShareTargetType,
  assertTargetId,
  replaceAccess,
  resolveShareTarget,
  setPublic,
  setShareMode,
  type ShareTargetType
} from '~~/server/utils/share'
import { deleteShareLinksByTarget } from '~~/server/utils/share-link'
import { parseShareBulkApplyPayload } from '~~/server/utils/share-bulk-apply'
import type { ShareBulkApplyPayload } from '~~/server/utils/share-bulk-apply'
import { SHARE_INHERIT } from '~~/types/share'

/** 一次最多处理多少项。超了直接 400，不截断 —— 截断等于「看起来全做了」 */
const MAX_TARGETS = 200

type BulkAction = 'reset' | 'unpublish' | 'removeLinks' | 'apply'

const ACTIONS: Record<BulkAction, string> = {
  reset: '恢复默认',
  unpublish: '取消公开',
  removeLinks: '撤销链接',
  apply: '批量设置'
}

/** apply 的载荷在共享模块里（server/utils/share-bulk-apply.ts），语义见那里的注释 */

/**
 * 把一套设置复写到一项上。全程在调用方开的 savepoint 内。
 *
 * 顺序与 /api/share/mode 一致：先 mode 再 isPublic。反过来的话，
 * setPublic(true) 之后 setShareMode 不碰 IsPublic，结果一样 —— 但顺序按
 * 「先状态后附属」读起来更顺，也避免以后加逻辑时踩到互相覆盖。
 *
 * `mode = 不分享` 时 setShareMode 会顺手清掉 IsPublic（避免「严格私密却对外
 * 可读」），**即使载荷里 isPublic 明确要 true**。这是既有语义：先设的不分享
 * 墙，后设的公开会把它顶成分享（setPublic 里有那个 CASE WHEN）。与单目标
 * 路径行为一致，不在这里另发明一套。
 */
async function applyToTarget(
  db: any,
  target: any,
  payload: ShareBulkApplyPayload
): Promise<void> {
  if (payload.mode !== null) {
    await setShareMode(db, target, payload.mode)
  }
  if (payload.isPublic !== null) {
    await setPublic(db, target, payload.isPublic)
  }
  if (payload.grants !== null) {
    await replaceAccess(db, target, payload.grants)
  }
}

export default defineEventHandler(async (event) => {
  // getMeAndTarget 而不是 requireAuth：管理视角（/manage/files）要能代被浏览者
  // 批量改分享，它读 useAdmin / targetUserId，authUserId 在管理员模式下会变成
  // targetUserId，于是 resolveShareTarget 的「必须是属主」自动变成
  // 「必须是这个被浏览用户的」—— 不用另写一套接口（与 /api/share/mode 同理）。
  //
  // 非管理员传 useAdmin 一律 403（resolveIdentity 里那道闸）。
  const { authUserId } = await getMeAndTarget(event)
  const ownerId = Number(authUserId)

  const db = getDb(event)
  if (!db) throw dbConnectionError

  const body = await readBody(event)
  const action = String(body?.action ?? '') as BulkAction
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    throw createError({
      statusCode: 400,
      message: `action 只能是 ${Object.keys(ACTIONS).join(' / ')}`
    })
  }

  const rawTargets = Array.isArray(body?.targets) ? body.targets : []
  if (!rawTargets.length) {
    throw createError({ statusCode: 400, message: '没有选中任何项目' })
  }
  if (rawTargets.length > MAX_TARGETS) {
    throw createError({ statusCode: 400, message: `一次最多处理 ${MAX_TARGETS} 项` })
  }

  // 载荷先校验，与目标数无关。放在这里（而不是循环里）意味着：非法载荷
  // 一个字节都写不下去。
  const applyPayload =
    action === 'apply'
      ? await parseShareBulkApplyPayload(body, ownerId, {
          // assertGrantees 的第一个形参是 db，而共享模块刻意不依赖 db
          // （这样测它不用起库）。这里把 db 闭包进去。
          assertGrantees: (userIds, owner) => assertGrantees(db, userIds, owner),
          assertPermissionBits
        })
      : null

  const results: Array<{
    targetType: string
    targetId: number | null
    ok: boolean
    message?: string
  }> = []

  /** 逐项失败。id 只在是整数时回传，NaN/Infinity 会被 JSON 抹成 null */
  const failure = (targetType: unknown, targetId: unknown, e: any) => {
    const n = Number(targetId)
    return {
      targetType: String(targetType ?? ''),
      targetId: Number.isInteger(n) ? n : null,
      ok: false as const,
      message: e?.statusMessage || e?.message || '操作失败'
    }
  }

  // 串行，不是 Promise.all：见文件头的说明
  for (const item of rawTargets) {
    const targetType = item?.targetType
    const targetId = Number(item?.targetId)

    // 归属校验放在 savepoint **之外**：它是只读的，校验没过就没必要开事务。
    // 校验自身抛错（类型非法 / id 非法 / 不是属主 / 已删）也归入逐项失败。
    let type: ShareTargetType
    let id: number
    let target: Awaited<ReturnType<typeof resolveShareTarget>>
    try {
      type = assertShareTargetType(targetType)
      id = assertTargetId(targetId)
      target = await resolveShareTarget(db, type, id, ownerId)
    } catch (e: any) {
      results.push(failure(targetType, targetId, e))
      continue
    }

    // 写入区间。savepoint 按项开 —— 单项原子，跨项隔离。
    await db.prepare('SAVEPOINT bulk_item_tx').bind().run()
    let settled = false
    try {
      if (action === 'apply') {
        await applyToTarget(db, target, applyPayload!)
      } else if (action === 'reset') {
        // 四步：先改三态再清公开（顺序理由见 applyToTarget 的注释）
        await setShareMode(db, target, SHARE_INHERIT)
        await setPublic(db, target, false)
        await replaceAccess(db, target, [])
        await deleteShareLinksByTarget(db, type, id, ownerId)
      } else if (action === 'unpublish') {
        await setPublic(db, target, false)
      } else {
        await deleteShareLinksByTarget(db, type, id, ownerId)
      }

      await db.prepare('RELEASE bulk_item_tx').bind().run()
      settled = true
      results.push({ targetType: type, targetId: id, ok: true })
    } catch (e: any) {
      // 单项失败不影响其余 —— 用户勾了 20 项，其中 1 项被并发删掉，
      // 不该让另外 19 项白做。message 回传，前端汇总时逐条说。
      results.push(failure(type, id, e))
    } finally {
      /**
       * 事务的唯一收口。没提交过就回滚。
       *
       * 为什么必须 finally 而不是只在 catch 里写：出口是随代码变的东西 ——
       * 以后有人加一条提前 return 或新的写步骤，finally 照样兜住，手写清单不会。
       *
       * 这里**不吞回滚失败**：ROLLBACK TO 失败意味着事务状态已经不可信，
       * 继续处理后面的项等于在坏状态上叠加，而悬着的 savepoint 会挂住整库
       * 写锁（fd973be 的教训）。宁可整个请求 500，也不要假装后面的项成功了。
       */
      if (!settled) {
        await db.prepare('ROLLBACK TO bulk_item_tx').bind().run()
        await db.prepare('RELEASE bulk_item_tx').bind().run()
      }
    }
  }

  const okCount = results.filter((r) => r.ok).length
  return {
    success: true,
    action,
    actionLabel: ACTIONS[action],
    okCount,
    failCount: results.length - okCount,
    results
  }
})
