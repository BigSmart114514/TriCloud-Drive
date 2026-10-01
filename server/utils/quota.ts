// 下载额度的归属与提示文案。
//
// 抽出来是因为同一个问题在两处被算：**download 真正预占时**，和
// **manifest 的预检 / 前端 confirm 对话框**。以前两边各写各的，
// 结果预检查 A 的额度、实际扣 B 的额度，对不上账 —— 用户看到「不会超限」，
// 点下去却被拒。放在一处，以后不会再漂。

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
