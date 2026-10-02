// server/utils/account.ts
// 子账户的读写守卫与共用的校验。
//
// 收在一处是因为这些判据必须在**每一处**都成立，而「每一处」很容易漏：
// 建号、改限额、重置密码、删除，四条接口各判一次，少一处就是能改别人孩子
// 的口子。

/** 能不能建子账户的判据 + 为什么不能 */
export interface SubAccountGate {
  allowed: boolean
  reason?: 'no_permission' | 'one_level' | 'quota_reached' | 'limit_zero'
}

/**
 * 这个账号能不能建子账户。
 *
 * 三道门，任一不过就返回原因（前端要能说清是哪一条，不能一律「无权」）：
 *
 *   1. `canSubAccount` —— 管理员在用户管理里显式给的开关。**这是主门。**
 *      没有它，任何登录用户都能建子账号、把文件分享出去，外面访客下载消耗的
 *      是他（作为主账号）的池。所以这个开关默认关，不给就不开。
 *   2. 只能一层 —— `parent_id` 自己的 parent_id 必须为 NULL。
 *      这条让配额链长度恒为 2，重算恒为 2 行，不需要递归 CTE；
 *      也让「我的子账户的额度从哪来」这个问题永远只有一层答案。
 *   3. `maxSubAccount` —— 0 表示不限（与 maxStorage/maxDownload 同口径）；
 *      非 0 时已有子账户数不能达到它。
 */
export async function subAccountGate(db: any, userId: number): Promise<SubAccountGate> {
  const me = await db
    .prepare('SELECT parent_id AS parentId, canSubAccount AS canSub, maxSubAccount AS maxSub FROM users WHERE id = ?')
    .bind(userId)
    .first()

  if (!me) return { allowed: false, reason: 'no_permission' }
  if (Number((me as any).canSub ?? 0) !== 1) return { allowed: false, reason: 'no_permission' }
  if ((me as any).parentId != null) return { allowed: false, reason: 'one_level' }

  const max = Number((me as any).maxSub ?? 0)
  if (max > 0) {
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE parent_id = ?')
      .bind(userId)
      .first()
    if (Number((row as any)?.n ?? 0) >= max) return { allowed: false, reason: 'quota_reached' }
  }

  return { allowed: true }
}

export const GATE_MESSAGES: Record<NonNullable<SubAccountGate['reason']>, string> = {
  no_permission: '当前账号不能创建子账户，请联系管理员开通',
  one_level: '子账户不能再创建下级账户',
  quota_reached: '已达到可创建子账户的数量上限',
  limit_zero: '已达到可创建子账户的数量上限'
}

/**
 * 取「目标确实是 me 的子账户」这一行。
 *
 * **不存在就返回 null，调用方一律 404**（不给 403）：403 会泄露「这个 id
 * 存在」，而按名字找子账户本来就该只在自己的范围里。
 */
export async function requireOwnChild(db: any, meId: number, childId: number): Promise<any | null> {
  return db
    .prepare('SELECT * FROM users WHERE id = ? AND parent_id = ?')
    .bind(childId, meId)
    .first()
}

/** 校验非负整数（额度、数量）。返回 null 表示合法。 */
export function checkNonNegative(v: any): string | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return '必须是 0 或正数'
  return null
}