// 批量设置的**载荷语义**。抽出来是为了能直接测，见下面「为什么要抽」。
//
// ## apply 的三个字段各自独立，都是「传了才改」
//
//   mode      共享三态：0 不分享 / 1 分享 / 2 继承
//   isPublic  对所有已登录用户可读
//   grants    授权名单，**整体覆盖**
//
// ## 最重要的一条：null/undefined ≠ 空数组
//
//   grants: undefined / null  →  **不碰**这一项的名单
//   grants: []                →  **清空**这一项的名单
//
// 这两件事在协议上必须分得清清楚楚。把它们合成同一个值，后果是「只改三态」
// 顺手把所有人从名单里抹了 —— 而用户界面上完全看不出发生了这件事。
//
// 单目标那条路（/api/share/mode）一直是这个语义，批量必须与它一致，
// 不另发明一套：同一个 ShareDialog 会把两种模式的表单发给同一个概念的服务端。

import { normalizeShareMode } from '~~/types/share'
import type { ShareMode } from '~~/types/share'

export interface ShareBulkApplyPayload {
  /** null = 不碰 */
  mode: ShareMode | null
  /** null = 不碰 */
  isPublic: boolean | null
  /** null = 不碰；[] = 清空；非空 = 整体替换 */
  grants: Array<{ userId: number; permission: number }> | null
}

/** 解析需要的外部依赖。注入而不是直接 import，为了能在测试里换掉查库那一步。 */
export interface ShareBulkApplyDeps {
  /**
   * 校验被授权人真实存在且不是属主本人，返回去重后的 id 列表。
   * 形态与 server/utils/share.ts 的 assertGrantees 一致。
   */
  assertGrantees: (userIds: number[], ownerId: number) => Promise<number[]>
  /** 校验并归一化单个 permission 位掩码。与 share.ts 的同名函数同源。 */
  assertPermissionBits: (value: unknown) => number
}

/**
 * 校验并归一化 apply 的载荷。**只该跑一次**，与目标数无关。
 *
 * 为什么放循环外：载荷非法时要能保证「一个字节都没写下去」。放进循环里的话，
 * 前 30 项已经改完了才轮到一个不存在的 userId，用户看到的是「改了一半」外加一个
 * 400 —— 那是最难收拾的一种状态。
 *
 * 为什么不在这里判归属：那是「这一项合不合法」，逐项不同，由调用方在循环里做。
 */
export async function parseShareBulkApplyPayload(
  body: any,
  ownerId: number,
  deps: ShareBulkApplyDeps
): Promise<ShareBulkApplyPayload> {
  const hasMode = body?.mode !== undefined && body?.mode !== null
  const hasPublic = body?.isPublic !== undefined && body?.isPublic !== null
  const hasGrants = body?.grants !== undefined && body?.grants !== null

  // 三者全空 = 「什么都没说」。这时如果静默返回全 null，循环里就是白跑一遍
  // 200 次事务，用户以为设置成功了。所以必须报错。
  if (!hasMode && !hasPublic && !hasGrants) {
    throw createError({ statusCode: 400, message: 'apply 至少要指定 mode / isPublic / grants 之一' })
  }

  // 走 normalizeShareMode 而不是直接 Number()：脏值（null / '' / [] / true）
  // 一律当「继承」，而不是被误判成「不分享」凭空立一道墙。
  // 数字 1 恰好等于 Number(true)，所以「true 被当成分享」是真实存在的坑。
  const mode = hasMode ? normalizeShareMode(body.mode) : null

  const isPublic = hasPublic ? (body.isPublic === true || body.isPublic === 1) : null

  let grants: ShareBulkApplyPayload['grants'] = null
  if (hasGrants) {
    const list: unknown[] = Array.isArray(body.grants) ? body.grants : []
    const normalized = list.map((g: any) => ({
      userId: Number(g?.userId),
      // 挡住未定义的位，顺手把存量 7 补成 15（normalizePermission）
      permission: deps.assertPermissionBits(g?.permission)
    }))

    if (normalized.length === 0) {
      // 空数组 = 明确的「清空」。不能走 assertGrantees —— 它要求至少一个人，
      // 而清空名单是完全合法的意图。
      grants = []
    } else {
      // 名单对每一项都一样，所以存在性只查一次
      const ids = await deps.assertGrantees(normalized.map((g) => g.userId), ownerId)
      // 按 assertGrantees 返回的顺序与去重结果重建，别自己信任前端给的顺序
      const byId = new Map(normalized.map((g) => [g.userId, g.permission]))
      grants = ids.map((id) => ({ userId: id, permission: byId.get(id)! }))
    }
  }

  return { mode, isPublic, grants }
}