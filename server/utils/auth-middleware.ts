// server/utils/auth-middleware.ts
import { getCookie } from 'h3'
import { verifyToken } from './auth'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'

export interface AuthenticatedUser {
  userId: number
  username?: string
  email?: string
  isAdmin?: boolean
  isSuperAdmin?: boolean
  canChangePassword?: boolean
  password_hash?: string
}

// 在一次请求内缓存认证结果，避免重复查询
function getAuthCache(event: any) {
  if (!event.context) event.context = {}
  if (!event.context.__authUser) event.context.__authUser = null
  return {
    get: () => event.context.__authUser as AuthenticatedUser | null,
    set: (u: AuthenticatedUser) => (event.context.__authUser = u),
  }
}

/**
 * 认证中间件 - 验证用户身份并返回用户信息
 * 默认：只解 token 返回 userId
 * 可选：withUser=true 时查 DB 返回更多信息（含管理员标记）
 */
export async function requireAuth(event: any, opts?: { withUser?: boolean }): Promise<AuthenticatedUser> {
  const cache = getAuthCache(event)
  const cached = cache.get()
  if (cached && (!opts?.withUser || (opts?.withUser && (cached.isAdmin !== undefined || cached.isSuperAdmin !== undefined)))) {
    return cached
  }

  const token = getCookie(event, 'auth-token')
  if (!token) {
    throw createError({ statusCode: 401, message: '未登录' })
  }

  const config = useRuntimeConfig()
  const decoded = verifyToken(token, config.sessionSecret)
  if (!decoded) {
    throw createError({ statusCode: 401, message: '登录已过期' })
  }

  const baseUser: AuthenticatedUser = { userId: decoded.userId }

  if (!opts?.withUser) {
    cache.set(baseUser)
    return baseUser
  }

  // 需要更多信息时查库
  const db = getDb(event)
  if (!db) {
    throw dbConnectionError
  }
  const row = await db
    .prepare('SELECT id, username, email, IsAdmin, IsSuperAdmin, canChangePassword, password_hash FROM users WHERE id = ?')
    .bind(decoded.userId)
    .first() as any

  if (!row) {
    throw createError({ statusCode: 401, message: '用户不存在或已被删除' })
  }

  const fullUser: AuthenticatedUser = {
    userId: row.id,
    username: row.username,
    email: row.email,
    isAdmin: !!(row.IsAdmin === true || row.IsAdmin === 1),
    isSuperAdmin: !!(row.IsSuperAdmin === true || row.IsSuperAdmin === 1),
    canChangePassword: !!(row.canChangePassword === true || row.canChangePassword === 1),
    password_hash: row.password_hash
  }
  cache.set(fullUser)
  return fullUser
}

/**
 * 需要管理员权限
 */
export async function requireAdmin(event: any): Promise<AuthenticatedUser> {
  const user = await requireAuth(event, { withUser: true })
  if (!(user.isAdmin || user.isSuperAdmin)) {
    throw createError({ statusCode: 403, message: '仅管理员可访问' })
  }
  return user
}

/**
 * 可选认证中间件 - 如果有 token 则验证，没有则返回 null
 *
 * opts.withUser 必须显式传：requireAuth 不带 withUser 时只回 { userId }，
 * 不含 isAdmin / isSuperAdmin。判断角色前忘了透传，条件会恒为假。
 */
export async function optionalAuth(event: any, opts?: { withUser?: boolean }): Promise<AuthenticatedUser | null> {
  try {
    return await requireAuth(event, opts)
  } catch {
    return null
  }
}

export interface MeAndTarget {
  me: AuthenticatedUser
  /** 数据范围：看谁的东西。缺省是自己。 */
  targetUserId: number
  /**
   * 是否以管理权限操作 = 显式传了 useAdmin 且调用者确实是管理员/超管。
   * 非管理员传 useAdmin 一律 403，不做静默降级 —— 静默降级会让「我以为我拿到了
   * 管理视图」和「我其实只看到自己的」无法区分。
   */
  adminMode: boolean
  /**
   * **鉴权身份**：所有权限判定都用它。
   *
   *   adminMode → targetUserId（以属主身份，纯归属，等同改造前的行为）
   *   否则     → me.userId（以行动者身份，只能碰自己有权的东西）
   *
   * 各接口凡是原来拿 targetUserId 判权限的地方，一律换成 authUserId。
   * 于是同一个接口靠这一个变量同时具备两种语义，不需要两套实现：
   * findAccessibleById 之类的「属主放行 / 无权 404 / 不足 403」三段逻辑
   * 在 authUserId=属主 时自然退化成纯归属判定。
   */
  authUserId: number
}

/** 布尔参数在 query / body 里可能是 true / 'true' / 1 / '1'，都当 true */
function readBool(v: any): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/**
 * 统一的鉴权入口：解析「以谁的身份、对谁操作、用什么权限」。
 *
 * 约定：
 *   targetUserId 缺省 = 自己          —— 数据范围
 *   useAdmin      缺省 = false        —— 是否管理权限
 *
 *   - useAdmin=true  → adminMode 必须成立，否则 403；authUserId = targetUserId
 *   - useAdmin=false → authUserId = me；targetUserId 只用来圈定候选集，
 *                      返回的每一行仍要过 me 的分享权限过滤
 */
export async function getMeAndTarget(event: any): Promise<MeAndTarget> {
  return resolveIdentity(event)
}

/**
 * 严格版：**指名别人就需要管理员身份**。
 *
 * 与 getMeAndTarget 的唯一区别就是把 b73e45a 原版那道闸加回来：
 *   targetUserId 指向别人 → 必须是管理员/超管，否则 403；
 *   且此时 adminMode 自动为真，authUserId = targetUserId。
 *
 * 为什么要另开一个而不是改 getMeAndTarget：d42614f 有意去掉了那道闸，把安全性
 * 从「不许指名别人」换成「指名别人拿不到任何权限」（authUserId）。这要求每个接口
 * 自己保证**不拿 targetUserId 做权限判定**。
 *
 * 而 targetUserId 必须继续可自由传入 —— 普通用户浏览别人的共享内容正是靠它
 * （files/index.get.ts 的「分享给我的」分支就是 targetUserId ≠ me 且非管理员）。
 * 所以宽松版不能动，需要严格语义的接口各自取这个。
 *
 * 什么时候该用严格版：targetUserId 会被当成**写操作的归属目标**或数据范围，
 * 也就是「我能不能动这个人的东西」。典型的就是改密码 ——
 * 宽松版下普通用户传一个 targetUserId 就能改掉别人的密码（原版代码拿 targetUserId
 * 当更新目标，闸门却是 `me.userId === targetUserId`，于是校验整段跳过）。
 *
 * 读别人的共享内容 → 用 getMeAndTarget。
 * 以写为目的、或者不确定 → 用严格版，多一次校验的代价可以忽略。
 */
export async function getMeAndTargetStrict(event: any): Promise<MeAndTarget> {
  return resolveIdentity(event, { gateTargetUserId: true })
}

/** 两个入口的共用内核。gateTargetUserId 决定要不要恢复原版那道闸 */
async function resolveIdentity(
  event: any,
  opts?: { gateTargetUserId?: boolean }
): Promise<MeAndTarget> {
  const me = await requireAuth(event, { withUser: true })
  const isGet = getMethod(event) === 'GET'
  const q: any = isGet ? getQuery(event) : null
  const b: any = isGet ? null : await readBody(event)

  const useAdmin = readBool(q?.useAdmin ?? b?.useAdmin)
  const isStaff = !!(me.isAdmin || me.isSuperAdmin)
  if (useAdmin && !isStaff) {
    throw createError({ statusCode: 403, message: '仅管理员可使用管理权限' })
  }
  let adminMode = useAdmin && isStaff

  const provided = q?.targetUserId ?? b?.targetUserId
  const targetUserId = provided != null && provided !== '' ? Number(provided) : me.userId
  if (!Number.isInteger(targetUserId) || targetUserId < 1) {
    throw createError({ statusCode: 400, message: '非法的 targetUserId' })
  }

  // 严格版：指名别人 = 一次管理操作。非管理员直接 403（不给静默降级）。
  if (opts?.gateTargetUserId && targetUserId !== me.userId) {
    if (!isStaff) {
      throw createError({ statusCode: 403, message: '仅管理员可操作他人的数据' })
    }
    adminMode = true
  }

  // 非超管不得进入超管的数据范围。
  //
  // 放在这里而不是逐个 handler，是因为这里是全部目标解析的共同入口
  // （files / folders / share / copy-paste / upload / download / change-password
  // 共 18 处），一处拦住就不会漏。
  //
  // 之前没有任何角色区分：普通管理员用 targetUserId 就能进超管的文件。
  // deleteUser 早就写了「普通管理员不能删除管理员或超管」，这里补的是同一条规则的
  // 数据侧 —— 不然就变成「不能删超管，却能翻他文件、能改他分享」。
  //
  // 只在「管理视图 + 自己不是超管」时多查这一次；超管和普通浏览都是零额外查询。
  // 严格版里 adminMode 可能由「指名别人」推出，所以这道防线照样会生效 ——
  // 否则普通管理员只要不传 useAdmin、只传 targetUserId 就能绕过它。
  if (adminMode && !me.isSuperAdmin) {
    const db = getDb(event)
    if (!db) throw dbConnectionError
    const row = await db
      .prepare('SELECT IsSuperAdmin FROM users WHERE id = ?')
      .bind(targetUserId)
      .first() as any
    if (row && (row.IsSuperAdmin === true || row.IsSuperAdmin === 1)) {
      throw createError({ statusCode: 403, message: '普通管理员不能访问超级管理员的数据' })
    }
  }

  return { me, targetUserId, adminMode, authUserId: adminMode ? targetUserId : me.userId }
}
