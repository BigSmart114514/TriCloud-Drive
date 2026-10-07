import type { Database } from '~~/server/utils/db'
import { placeholders, uniqPositiveInts } from '~~/server/utils/functions'
import { normalizePermission, normalizeShareMode, PERM_ALL, SHARE_NONE, SHARE_SHARED } from '~~/types/share'
import type { ShareMode } from '~~/types/share'

export type ShareTargetType = 'file' | 'folder'

export interface ShareTarget {
  type: ShareTargetType
  /** 所在表：files 或 folders */
  table: 'files' | 'folders'
  id: number
  /** 属主 id，只有属主（或管理员代操作）才能改授权 */
  ownerId: number
}

export function assertShareTargetType(value: any): ShareTargetType {
  if (value === 'file' || value === 'folder') return value
  throw createError({ statusCode: 400, message: 'targetType 必须是 file 或 folder' })
}

export function assertTargetId(value: any): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id < 1) {
    throw createError({ statusCode: 400, message: '非法的 targetId' })
  }
  return id
}

/** 定位分享目标并校验操作者是属主。授权管理是属主专属权力，与访问权限无关。 */
export async function resolveShareTarget(
  db: Database,
  type: ShareTargetType,
  targetId: number,
  actingUserId: number
): Promise<ShareTarget> {
  const table = type === 'file' ? 'files' : 'folders'
  const row = await db.prepare(`SELECT id, user_id AS userId FROM ${table} WHERE id = ?`).bind(targetId).first()
  if (!row) {
    throw createError({ statusCode: 404, message: type === 'file' ? '文件不存在' : '文件夹不存在' })
  }
  if (Number(row.userId) !== actingUserId) {
    throw createError({ statusCode: 403, message: '只有属主可以管理分享' })
  }
  return { type, table, id: targetId, ownerId: Number(row.userId) }
}

export function assertPermissionBits(value: any): number {
  const raw = Number(value)
  if (!Number.isInteger(raw) || raw <= 0) {
    throw createError({ statusCode: 400, message: '非法的 permission' })
  }
  if (raw & ~PERM_ALL) {
    throw createError({ statusCode: 400, message: 'permission 含未定义的权限位' })
  }
  return normalizePermission(raw)
}

/**
 * 搜索「可授权的人」时要排除掉的 id。
 *
 * ## 为什么它和 assertGrantees 放在同一个文件
 *
 * 「谁能进授权名单」是一条规则，它有**两个执行点**：写时（assertGrantees，
 * 不合格就 400）与读时（candidates 搜索，不合格的人干脆搜不出来）。
 *
 * 这条规则曾经有两份拷贝，而且**不一致** —— 读时那份把「我」和「属主」两个
 * 都排掉了：
 *
 *   const excluded = new Set([meId])
 *   if (adminMode) excluded.add(targetUserId)
 *
 * 注释里写的意图（「管理视角下『自己』是**属主**」）与代码不符：意图是
 * 管理视角下只排属主，代码是两个都排。后果是管理员在替别人管分享时
 * **搜不到自己**，于是「给自己开一份别人的文件访问」这个操作根本做不了 ——
 * 而 assertGrantees 那一侧本来就允许它（它只拒属主，不拒行动者）。
 *
 * 这正是 cos.ts 文件头记着的那个形状：同一段判断抄了几份，其中一份改动
 * 或失配，其余的静默继续工作。规则只有一份，两处都从这里取。
 *
 * ## 管理员为什么该能被搜到
 *
 * 给自己开一份别人文件的访问是合法且有用的：那个人账号一旦被删，管理员是通过
 * 管理员身份看到的文件就没了，而通过名单拿到的那一份还在。OWNER_GUARD_TRIGGER
 * 也只拦 `file_access.user_id = files.user_id`，不拦这个。
 *
 * 非管理视角下不存在这个问题 —— 那时「我」就是属主，排掉是应该的。
 */
export function candidateExclusions(params: {
  /** 发起这次操作的人 */
  meId: number
  /** 数据属主。缺省是自己 */
  targetUserId: number
  /** 是否以管理权限操作 */
  adminMode: boolean
  /** 调用方传来的「已在名单里」逗号串 */
  exclude?: string | null
}): number[] {
  const { meId, targetUserId, adminMode } = params

  // 管理视角下「不能进名单的人」只有属主；非管理视角下就是我（= 属主）。
  // 两种情况下最终都排掉属主，区别只在**是否连行动者一起排掉**。
  const excluded = new Set<number>(adminMode ? [Number(targetUserId)] : [Number(meId)])

  // 已经在名单里的人不用再出现。
  if (params.exclude) {
    for (const part of String(params.exclude).split(',')) {
      const n = Number(part)
      // 只收正整数。'abc' → NaN、'0' → 0、'-3' → -3、空段 → 0，放进 NOT IN
      // 会带上一个假排除项。调用方很容易写出「5,,9」这种（尾逗号、连续逗号），
      // 所以判据必须挡住 0 与负数，不能只挡 NaN。
      //
      // 这里**没有** trim()：Number() 自己就吃首尾空白（Number(' 5 ') === 5），
      // 所以那一步是死代码。原先有个 trim() 并配着一条「靠 trim 把空段变成
      // 空串」的注释 —— 而空段本来就直接得到 0，注释与代码都在演一出并不存在
      // 的因果。变异扫描试图去掉它，结果是「抓不到」，因为去掉之后行为一模一样
      // —— 那正是它没有作用的证据。
      if (Number.isSafeInteger(n) && n > 0) excluded.add(n)
    }
  }

  return [...excluded]
}

/** 被授权人必须真实存在，且不能是属主本人 */
export async function assertGrantees(db: Database, userIds: number[], ownerId: number): Promise<number[]> {
  const ids = uniqPositiveInts(userIds)
  if (!ids.length) {
    throw createError({ statusCode: 400, message: 'userIds 不能为空' })
  }
  if (ids.includes(ownerId)) {
    throw createError({ statusCode: 400, message: '不能授权给属主本人' })
  }
  const res = await db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all()
  const found = new Set((res?.results || []).map((r: any) => Number(r.id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) {
    throw createError({ statusCode: 400, message: `用户不存在：${missing.join(', ')}` })
  }
  return ids
}

function accessTable(target: ShareTarget) {
  return target.type === 'file' ? 'file_access' : 'folder_access'
}
function targetColumn(target: ShareTarget) {
  return target.type === 'file' ? 'file_id' : 'folder_id'
}

/**
 * 授权：已存在则更新权限。先 UPDATE 再 INSERT，避免依赖各方言的 upsert 语法。
 *
 * 注意：这里**不会**去动 Shared —— 授权名单和「要不要切断继承」是独立的两件事。
 * 早期版本在这里自动把 Shared 置 1，结果属主只是想定向加一个人，
 * 却把这个节点变成了边界，把上层已共享的其他人全挡在门外。
 */
/**
 * 整体覆盖授权名单。
 *
 * 取代原来的 grant / revoke 两个接口：接口只暴露「这份名单应该长这样」，
 * 由本函数算出增删改。前端改一个人的权限、或把人移出，都只是改一份数组后重发，
 * 不用分别调「加」和「删」。
 *
 * 事务外逐步执行：同库里 delete-then-insert 有先后依赖，不能并发。
 */
export async function replaceAccess(
  db: Database,
  target: ShareTarget,
  entries: Array<{ userId: number; permission: number }>
): Promise<void> {
  const table = accessTable(target)
  const column = targetColumn(target)

  // 同一人只保留一条，取最后一次出现的（后端不依赖前端去重）
  const wanted = new Map<number, number>()
  for (const e of entries) wanted.set(e.userId, e.permission)

  const current = await db
    .prepare(`SELECT user_id AS userId, permission FROM ${table} WHERE ${column} = ?`)
    .bind(target.id)
    .all()
  const have = new Map<number, number>()
  for (const row of current?.results || []) have.set(Number(row.userId), Number(row.permission))

  // 名单里没有的 → 删
  for (const userId of have.keys()) {
    if (wanted.has(userId)) continue
    await db
      .prepare(`DELETE FROM ${table} WHERE ${column} = ? AND user_id = ?`)
      .bind(target.id, userId)
      .run()
  }

  // 名单里有的 → 变了就改，没变就跳过
  for (const [userId, permission] of wanted) {
    if (have.get(userId) === permission) continue
    const updated = await db
      .prepare(`UPDATE ${table} SET permission = ? WHERE ${column} = ? AND user_id = ?`)
      .bind(permission, target.id, userId)
      .run()
    const changes = Number((updated as any)?.meta?.changes ?? 0)
    if (changes === 0) {
      await db
        .prepare(`INSERT INTO ${table} (${column}, user_id, permission) VALUES (?, ?, ?)`)
        .bind(target.id, userId, permission)
        .run()
    }
  }
}

/** 设置共享三态。不分享时顺带清掉公开标记，避免「严格私密却对外可读」的自相矛盾。 */
export async function setShareMode(
  db: Database,
  target: ShareTarget,
  mode: ShareMode
): Promise<ShareMode> {
  const m = normalizeShareMode(mode)
  if (m === SHARE_NONE) {
    await db
      .prepare(`UPDATE ${target.table} SET Shared = ?, IsPublic = 0 WHERE id = ?`)
      .bind(m, target.id)
      .run()
  } else {
    await db
      .prepare(`UPDATE ${target.table} SET Shared = ? WHERE id = ?`)
      .bind(m, target.id)
      .run()
  }
  return m
}

/** 设置公开（等价于给所有已登录用户 READ），属主专属 */
export async function setPublic(
  db: Database,
  target: ShareTarget,
  isPublic: boolean
): Promise<boolean> {
  const next = isPublic ? 1 : 0
  if (next) {
    // 公开是「分享」的一种，继承态下也允许，权限仍只到 READ
    await db
      .prepare(`UPDATE ${target.table} SET IsPublic = 1, Shared = CASE WHEN Shared = ? THEN ? ELSE Shared END WHERE id = ?`)
      .bind(SHARE_NONE, SHARE_SHARED, target.id)
      .run()
  } else {
    await db
      .prepare(`UPDATE ${target.table} SET IsPublic = 0 WHERE id = ?`)
      .bind(target.id)
      .run()
  }
  return next === 1
}

/** 该目标当前的共享状态 */
export async function getShareState(db: Database, target: ShareTarget) {
  const row = await db
    .prepare(`SELECT Shared, IsPublic FROM ${target.table} WHERE id = ?`)
    .bind(target.id)
    .first()
  return {
    mode: normalizeShareMode(row?.Shared),
    isPublic: Number(row?.IsPublic ?? 0) === 1
  }
}

/** 授权名单 + 用户信息（展示用）。user 查不到时留 null，由前端决定怎么兜底 */
export interface GrantWithUser {
  userId: number
  permission: number
  user: { username: string | null; email: string | null } | null
}

/**
 * 读授权名单并补上用户名/邮箱。
 *
 * /api/share/list 和 /api/share/mode 都用这一个。以前两边各写各的：
 * list 补了用户名、mode 没补，于是「打开弹窗 → 加人 → 保存」之后名单里的
 * user 字段被 mode 的返回值抹掉，界面上变成「未知用户」，重开弹窗才恢复。
 * 返回结构必须两边一致，否则就是同一个 bug 再来一遍。
 */
export async function listGrantsWithUsers(db: Database, target: ShareTarget): Promise<GrantWithUser[]> {
  const table = accessTable(target)
  const column = targetColumn(target)

  const rows = await db
    .prepare(`SELECT user_id AS userId, permission FROM ${table} WHERE ${column} = ? ORDER BY user_id ASC`)
    .bind(target.id)
    .all()

  const grants = (rows?.results || []).map((r: any) => ({
    userId: Number(r.userId),
    permission: normalizePermission(r.permission)
  }))
  if (!grants.length) return []

  const users = await db
    .prepare(`SELECT id, username, email FROM users WHERE id IN (${placeholders(grants.length)})`)
    .bind(...grants.map((g) => g.userId))
    .all()

  const userMap = new Map(
    (users?.results || []).map((u: any) => [
      Number(u.id),
      { username: u.username ?? null, email: u.email ?? null }
    ])
  )

  return grants.map((g) => ({ ...g, user: userMap.get(g.userId) ?? null }))
}
