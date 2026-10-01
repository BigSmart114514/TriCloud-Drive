// 批量处置分享设置。分享管理页的批量按钮走这里。
//
// ## 三个动作
//
//   reset       恢复默认：三态→继承 + 取消公开 + 清空授权名单 + 撤销全部链接
//   unpublish   取消公开：只动 IsPublic，名单和三态保留
//   removeLinks 撤销链接：只撤链接，别的都不动（最常忘的就是这个）
//
// **reset 为什么必须连带撤链**：撤链之后这一项四个条件全不满足，它才会从
// 列表里消失。留着链接的话点完「恢复默认」，那一行还躺在页面上，
// 用户会以为没生效 —— 而实际上「有链接」本身就是一项非默认设置。
//
// 为什么没有第四个「只把三态设成继承」：那个动作点完，名单和链接都还在，
// 条目照样不出列表，语义上等于「没恢复」。而它真正对应的场景
// （我要停止当挡板但保留名单）在分享弹窗里改三态两下就够，
// 批量条只放语义明确、点了就能看出结果的处置。
//
// ## 归属校验逐项做，且与 /api/share/mode 同一口径
//
// 传一串 id 进来，就意味着可以传**别人的** id。每一项都过
// resolveShareTarget（属主才放行），失败的那项单独记失败，不影响其余。
// 这是「批量」最容易出的洞：整体校验通过就以为每项都合法了。
//
// ## 串行执行
//
// 同一个 sqlite3 handle 并发跑语句会让本机原生绑定崩（项目硬约束）。
// 目标数有上限（MAX_TARGETS），串行也不会让请求拖太久。

import { requireAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import {
  assertShareTargetType,
  assertTargetId,
  replaceAccess,
  resolveShareTarget,
  setPublic,
  setShareMode,
  type ShareTargetType
} from '~~/server/utils/share'
import { deleteShareLinksByTarget } from '~~/server/utils/share-link'
import { SHARE_INHERIT } from '~~/types/share'

/** 一次最多处理多少项。超了直接 400，不截断 —— 截断等于「看起来全做了」 */
const MAX_TARGETS = 200

type BulkAction = 'reset' | 'unpublish' | 'removeLinks'

const ACTIONS: Record<BulkAction, string> = {
  reset: '恢复默认',
  unpublish: '取消公开',
  removeLinks: '撤销链接'
}

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const ownerId = Number(me.userId)

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

  const results: Array<{
    targetType: string
    targetId: number | null
    ok: boolean
    message?: string
  }> = []

  // 串行，不是 Promise.all：见文件头的说明
  for (const item of rawTargets) {
    const targetType = item?.targetType
    const targetId = Number(item?.targetId)

    try {
      const type: ShareTargetType = assertShareTargetType(targetType)
      const id = assertTargetId(targetId)

      // 属主校验。别人（以及已删）的项在这里被挡住
      const target = await resolveShareTarget(db, type, id, ownerId)

      if (action === 'reset') {
        // 顺序有讲究：先改三态再清公开。反过来的话 setPublic(false) 之后
        // setShareMode 不会再碰 IsPublic，结果一样，但顺序按「先状态后附属」
        // 读起来更顺，也避免以后加逻辑时踩到互相覆盖。
        await setShareMode(db, target, SHARE_INHERIT)
        await setPublic(db, target, false)
        await replaceAccess(db, target, [])
        await deleteShareLinksByTarget(db, type, id, ownerId)
      } else if (action === 'unpublish') {
        await setPublic(db, target, false)
      } else {
        await deleteShareLinksByTarget(db, type, id, ownerId)
      }

      results.push({ targetType: type, targetId: id, ok: true })
    } catch (e: any) {
      // 单项失败不影响其余 —— 用户勾了 20 项，其中 1 项被并发删掉，
      // 不该让另外 19 项白做。message 回传，前端汇总时逐条说。
      results.push({
        targetType: String(targetType ?? ''),
        targetId: Number.isInteger(targetId) ? targetId : null,
        ok: false,
        message: e?.statusMessage || e?.message || '操作失败'
      })
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
