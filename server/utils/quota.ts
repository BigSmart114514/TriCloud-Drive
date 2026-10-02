// 下载额度的归属与提示文案。
//
// 抽出来是因为同一个问题在两处被算：**download 真正预占时**，和
// **manifest 的预检 / 前端 confirm 对话框**。以前两边各写各的，
// 结果预检查 A 的额度、实际扣 B 的额度，对不上账 —— 用户看到「不会超限」，
// 点下去却被拒。放在一处，以后不会再漂。

import { isExpired } from '~~/server/utils/time'
import type { QuotaFail } from '~~/server/utils/sub-account'

/**
 * 「这个账号没过期的」这个条件的 SQL 片段。
 *
 * 抽出来的原因与本文件其余部分同一个：以前「能不能用这个账号」散在四条
 * 预占语句里各写一遍，而只有上传那条写了 —— 结果套餐过期的账号传不了文件，
 * 却照样能下载和预览。少写一处就是一个后门，而且没人能从代码上看出少了。
 *
 * 它是表达式，能塞进 UPDATE 的 WHERE 参与原子判定，与 quotaOwnerExpired
 * 的预判一起用（预判给准确文案，WHERE 兜底防漏）—— 见 download.post.ts。
 *
 * ## 为什么多了 TRIM 和 COALESCE
 *
 * 这里用字符串比较，而 `isExpired` 用 `parseSqlDateTime` 解析。两者对
 * **空白值**的判断本来是相反的：`expire_at = ''` 时
 * parseSqlDateTime 返回 null（没过期），而 `'' > '2026-10-02 07:00:00'`
 * 为 false（当成过期）。后果是管理员在用户管理里清空过期时间后，
 * 预判放行、WHERE 挡下，最后报的是「额度不足」—— 额度明明是满的，
 * 而他真正要做的是重新设一个到期时间。
 *
 * TRIM/COALESCE 把空白值（NULL / 空串 / 空格）统一放行，与 parseSqlDateTime
 * 对齐。COALESCE 是因为 SQL 里 NULL 不会等于 ''，少它这个条件就漏了 NULL。
 *
 * **残留差异（已确认可接受）**：`expire_at` 是一个畸形字符串时（不是日期、
 * 也不是空白），`parseSqlDateTime` 返回 null 判「没过期」，而这里的比较
 * 结果取决于首字符的字节值，可能判「已过期」。也就是这种值会被 SQL 挡住、
 * 却报「额度不足」。这是**偏严**而非偏松 —— 挡得住、只是文案不准，
 * 而且只有把 expire_at 写成非法串才碰得到（updateUser 原本直接透传，
 * 不做校验；前端 datetime-local 只会产出合法值或空串）。
 */
export const NOT_EXPIRED_SQL = "(TRIM(COALESCE(expire_at, '')) = '' OR expire_at > ?)"

/** 额度归属那一行的账号是否已过期 */
export async function quotaOwnerExpired(db: any, quotaOwnerId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT expire_at FROM users WHERE id = ?')
    .bind(quotaOwnerId)
    .first()
  return isExpired((row as { expire_at?: any } | null)?.expire_at)
}

/**
 * 把「预占失败的原因」翻译成一句提示。
 *
 * 单独抽出来是因为**说清楚是哪一层不够**很重要：子账户撞了自己的上限，
 * 去调主账号的池是白费力气；反过来池满了，去调自己的上限也一样没用。
 * 一律说「额度不足」的话，用户只能靠试。
 *
 * actorId 为 null（匿名访客）与 adminMode 的分流口径与 quotaExceededMessage
 * 相同，理由也相同：链接最容易外泄，别把账号名挂在错误提示里。
 */
export async function quotaFailMessage(
  db: any,
  /**
   * 收紧成 QuotaFail 而不是 string：这些字面量只在 sub-account.ts 里定义，
   * 参数写成 string 的话调用处拼错（比如 'expiredParent'）不会报错，只会在
   * 运行时分流到「不是过期也不是不够」的分支上，弹出「额度不足」——
   * 过期的人去调限额，死胡同。**type-only 导入，编译后不存在，无循环依赖。**
   */
  fail: QuotaFail,
  quotaOwnerId: number,
  actorId: number | null,
  adminMode: boolean
): Promise<string> {
  const isParentLevel = fail.endsWith('_parent')
  const isExpired = fail.startsWith('expired')
  const isStorage = fail.startsWith('storage')
  const what = isStorage ? '存储空间' : '下载流量'

  // 访客：只知道「内容所属账号」这一层，不点名字
  if (actorId === null) {
    return isExpired
      ? '无法访问：该内容所属账号的套餐已过期'
      : `${what}不足：该内容所属账号的${isStorage ? '容量' : '流量'}已用尽`
  }

  const row = (await db
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(quotaOwnerId)
    .first()) as { username?: string } | null
  const name = row?.username || `用户 ${quotaOwnerId}`

  // 主账号那一层不够：额度记在别人头上，要点出是谁（子账户知道主账号是谁，
  // 能去协调；不点的话他只会反复试自己的上限）
  if (isParentLevel) {
    const chain = await db
      .prepare('SELECT u2.username AS pn FROM users u1 JOIN users u2 ON u2.id = u1.parent_id WHERE u1.id = ?')
      .bind(quotaOwnerId)
      .first() as { pn?: string } | null
    const parentName = chain?.pn || '主账号'
    if (isExpired) return `无法${isStorage ? '使用' : '下载'}：主账号「${parentName}」的套餐已过期`
    return isStorage
      ? `存储空间不足：主账号「${parentName}」的共享容量已用尽`
      : `下载额度不足：主账号「${parentName}」的共享下载流量已用尽`
  }

  // 自己那一层
  if (Number(quotaOwnerId) === Number(actorId)) {
    if (isExpired) return '账号已过期，无法继续操作'
    return isStorage
      ? '存储空间不足，无法继续操作'
      : '下载额度不足：下载该文件将超过您的下载流量上限'
  }
  if (adminMode) {
    return isExpired
      ? `无法代「${name}」操作：该账号的套餐已过期`
      : `额度不足：代「${name}」操作会计入您的${what}，已超过您的上限`
  }
  return isExpired
    ? `无法${isStorage ? '使用' : '下载'}：「${name}」的套餐已过期`
    : `${what}不足：「${name}」的${isStorage ? '容量' : '流量'}已用尽`
}

/**
 * 这次下载记在谁头上。
 *
 *   管理员代管（adminMode）→ 记管理员自己。代管是「我去看你的东西」，
 *     花的是我自己的带宽，不该让你替我付。原来记的是 authUserId（= targetUserId），
 *     等于你被浏览一次就掉额度，而你根本没感知。
 *
 *   普通用户 / 分享链接   → 记文件属主（fileOwnerId）。文件是从谁的配额里出的就记谁，
 *     这样属主能看到自己的流量在被谁消耗。
 *
 * 链接访问也走这一支：拿链接的人没有身份可记，只能记内容的属主。
 */
export function resolveQuotaOwnerId(adminMode: boolean, actorId: number, fileOwnerId: number): number {
  return adminMode ? Number(actorId) : Number(fileOwnerId)
}

/**
 * 下载额度不足时的提示。
 *
 * 额度记在 quotaOwnerId 头上，而这个人不一定是操作者，所以文案不能说「您的」——
 * 尤其额度可能记在**完全不知情**的第三方身上（分享链接的属主），说「您」会让人
 * 去查自己的额度，怎么都查不出来。
 *
 * actorId 为 null 表示**没有操作者** —— 分享链接的访问者就是这种：拿着 token
 * 的陌生人，压根没有账号。这种情况下**不点属主的名字**：
 *   - 这个信息对访客毫无用处，他既不能加额度也不能联系属主
 *   - 而链接恰恰是最容易外泄的东西（转发、贴错群），把账号名挂在错误提示里
 *     等于给每个拿到链接的人发一份用户名
 * 登录用户那条路径不受影响：他们至少和属主有共享关系，知道是谁才可能去协调。
 */
export async function quotaExceededMessage(
  db: any,
  quotaOwnerId: number,
  actorId: number | null,
  adminMode: boolean
): Promise<string> {
  if (actorId === null) {
    return '下载额度不足：该内容所属账号的下载流量已用尽，请联系该账号的属主'
  }

  const row = (await db
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(quotaOwnerId)
    .first()) as { username?: string } | null
  const name = row?.username || `用户 ${quotaOwnerId}`

  if (Number(quotaOwnerId) === Number(actorId)) {
    return '下载额度不足：下载该文件将超过您的下载流量上限'
  }
  if (adminMode) {
    return `下载额度不足：代「${name}」下载会计入您的下载流量，已超过您的上限`
  }
  return `下载额度不足：该文件属于「${name}」，下载它消耗的是对方的下载流量，且会超过对方的上限`
}

/**
 * 账号已过期时的提示。
 *
 * 存在的原因：过期和「额度用尽」是**两件不同的事**，处理方式也完全不同 ——
 * 一个要续费，一个要调限额。原来只有上传分得开（types/error.ts 的
 * userExpiredError），下载一律报「额度不足」，等于让人去查额度、查额度是满的，
 * 反复试也没用。
 *
 * 分流口径与 quotaExceededMessage 完全一致（含匿名访客不点属主名字那条），
 * 理由同样是链接最容易外泄。
 */
export async function quotaExpiredMessage(
  db: any,
  quotaOwnerId: number,
  actorId: number | null,
  adminMode: boolean
): Promise<string> {
  if (actorId === null) {
    return '无法下载：该内容所属账号的套餐已过期'
  }

  const row = (await db
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(quotaOwnerId)
    .first()) as { username?: string } | null
  const name = row?.username || `用户 ${quotaOwnerId}`

  if (Number(quotaOwnerId) === Number(actorId)) {
    return '无法下载：您的套餐已过期，请续期后重试'
  }
  if (adminMode) {
    return `无法代「${name}」下载：该账号的套餐已过期`
  }
  return `无法下载：该文件属于「${name}」，对方的套餐已过期，暂时取不到`
}
