// server/utils/auth-middleware.ts
import { getCookie } from 'h3'
import { verifyToken } from './auth'
import { getDb } from '~~/server/utils/db-adapter'

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
    throw createError({ statusCode: 401, statusMessage: '未登录' })
  }

  const config = useRuntimeConfig()
  const decoded = verifyToken(token, config.sessionSecret)
  if (!decoded) {
    throw createError({ statusCode: 401, statusMessage: '登录已过期' })
  }

  const baseUser: AuthenticatedUser = { userId: decoded.userId }

  if (!opts?.withUser) {
    cache.set(baseUser)
    return baseUser
  }

  // 需要更多信息时查库
  const db = getDb(event)
  if (!db) {
    throw createError({ statusCode: 500, statusMessage: '数据库连接失败' })
  }
  const row = await db
    .prepare('SELECT id, username, email, IsAdmin, IsSuperAdmin, canChangePassword, password_hash FROM users WHERE id = ?')
    .bind(decoded.userId)
    .first() as any

  if (!row) {
    throw createError({ statusCode: 401, statusMessage: '用户不存在或已被删除' })
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
    throw createError({ statusCode: 403, statusMessage: '仅管理员可访问' })
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
  const me = await requireAuth(event, { withUser: true })
  const isGet = getMethod(event) === 'GET'
  const q: any = isGet ? getQuery(event) : null
  const b: any = isGet ? null : await readBody(event)

  const useAdmin = readBool(q?.useAdmin ?? b?.useAdmin)
  const isStaff = !!(me.isAdmin || me.isSuperAdmin)
  if (useAdmin && !isStaff) {
    throw createError({ statusCode: 403, statusMessage: '仅管理员可使用管理权限' })
  }
  const adminMode = useAdmin && isStaff

  const provided = q?.targetUserId ?? b?.targetUserId
  const targetUserId = provided != null && provided !== '' ? Number(provided) : me.userId
  if (!Number.isInteger(targetUserId) || targetUserId < 1) {
    throw createError({ statusCode: 400, statusMessage: '非法的 targetUserId' })
  }

  return { me, targetUserId, adminMode, authUserId: adminMode ? targetUserId : me.userId }
}
