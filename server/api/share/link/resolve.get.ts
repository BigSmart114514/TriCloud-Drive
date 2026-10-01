// server/api/share/link/resolve.get.ts
//
// 拿一个 token 问「它现在还能用吗，指向什么」。**匿名可调**，加在中间件的
// LINK_PUBLIC_PATHS 里 —— 访客点开分享链接时不保证有账号，校验有效性这一步
// 必须能在无 cookie 的情况下完成。
//
// ## 返回值：结论放在 body 里，不靠状态码
//
//   200 { valid: true,  active: true }               → 打开
//   200 { valid: true,  active: false, reason }      → 保留在侧栏，标「当前不可用」
//   200 { valid: false, reason: 'token_not_found' }  → 前端删本地存储
//   200 { valid: false, reason: 'target_gone' }      → 前端删本地存储
//   5xx / 网络失败                                    → 前端什么都不做
//
// **为什么无效也返回 200**：前端拿到这个结果要做一个不可逆的决定 —— 把用户的本地
// 收藏删掉，删了找不回来。而「无效」这个结论只能来自 `valid: false` 这一个字段。
//
// 之前这版是「HTTP 404 表示无效，前端看 statusCode 判」—— 错在 404 能来自的地方太多：
// 网关、代理、上层兜底、一次数据库抖动。只要响应是 404，前端就会清空用户的东西，
// 而服务端其实什么都没说。现在判断依据只有一个字段；5xx 就老老实实是 5xx，
// 那是「这次没问成」，前端据此不动。
//
// ## 「不可用」与「无效」是两件事
//
// valid=true 但 active=false：链接和目标都在，只是继承态下上游没人拍板（或被墙挡住）。
// 属主随时可能把上游改成「分享」，那时候它就好了 —— 这时候删是破坏性的。
import { optionalAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import {
  linkGrantsFile,
  linkGrantsFolder,
  linkNotActiveMessage,
  requireShareLink,
  resolveLinkTargetOutcome
} from '~~/server/utils/share-link'
import { getQuery } from 'h3'

export default defineEventHandler(async (event) => {
  const q = getQuery(event) as { link?: string }
  // 形状不合法直接 400。与其它接口同一个 requireShareLink：
  // token 直接进 SQL 参与查询，挡掉畸形串能省一次注定落空的查库。
  const link = requireShareLink(q?.link)

  const db = getDb(event)
  if (!db) throw dbConnectionError

  const outcome = await resolveLinkTargetOutcome(db, link)

  // 「无效」的两种情况。reason 分开是因为提示语该不一样 ——
  // token_not_found 是「链接被撤销了」，target_gone 是「它指的东西没了」。
  if (outcome.status !== 'ok') {
    return {
      success: true,
      link,
      valid: false,
      active: false,
      reason: outcome.status
    }
  }

  const target = outcome.target

  // 目标名，给侧栏显示。**刻意不返回属主用户名**：
  // 与 quotaExceededMessage 同一个理由 —— 链接是最容易外泄的东西
  // （转发、贴错群），把账号名挂在任何一个链接触发的响应里，
  // 等于给每个拿到链接的人发一份用户名。
  const table = target.type === 'file' ? 'files' : 'folders'
  const nameCol = target.type === 'file' ? 'filename' : 'name'
  const row = await db
    .prepare(`SELECT ${nameCol} AS name FROM ${table} WHERE id = ?`)
    .bind(target.id)
    .first()
  const name = String(row?.name ?? '')

  // 生效判定复用链接自己的边界算法（BOUNDARY_CTE），不另写一套。
  const active = target.type === 'file'
    ? await linkGrantsFile(db, link, target.id)
    : await linkGrantsFolder(db, link, target.id)

  /**
   * reason 分访客/属主两套：属主看到的是「怎么改能生效」，
   * 访客看到的是「去找分享的人」—— 他没有账号，改不了任何设置。
   *
   * optionalAuth 只读 cookie，取不到就是匿名，走访客口径（更安全）。
   */
  const session = await optionalAuth(event)

  return {
    success: true,
    link,
    valid: true,
    active,
    targetType: target.type,
    targetId: target.id,
    name,
    reason: active
      ? null
      : linkNotActiveMessage(session ? Number(session.userId) : null, target.ownerId)
  }
})