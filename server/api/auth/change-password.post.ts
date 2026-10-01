// server/api/auth/change-password.post.ts
import { readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { getMeAndTargetStrict } from '~~/server/utils/auth-middleware'
import { validatePassword, verifyPassword, hashPassword } from '~~/server/utils/auth'

/**
 * 改密码。两条路径：
 *
 *   自助     services/change-password.vue 只传 currentPassword + newPassword
 *   代管重置 manage/user.vue 传 targetUserId + newPassword（只传一个 id，不传原密码）
 *
 * 这里用 **getMeAndTargetStrict** 而不是 getMeAndTarget，原因是这个接口把
 * targetUserId 当成「要改谁的密码」—— 也就是写操作的归属目标，必须是管理员才能
 * 指名别人。原来那版判断写的是 `me.userId === targetUserId` 才做校验，
 * 于是「我不是目标」被当成了「我是管理员」：任何登录用户传一个 targetUserId
 * 就能改掉别人的密码，且不需要原密码（旧密码立刻失效 = 完整账号接管）。
 *
 * 严格版在解析身份时就拦掉非管理员指名别人的情况；并且它会把 adminMode 置真、
 * authUserId 指向 targetUserId，所以管理员那条重置路径照旧工作，前端不用改。
 */
export default defineEventHandler(async (event) => {
  const { authUserId, adminMode } = await getMeAndTargetStrict(event)

  const body = await readBody(event)
  const currentPassword = String(body?.currentPassword || '')
  const newPassword = String(body?.newPassword || '')

  if (!validatePassword(newPassword)) {
    throw createError({
      statusCode: 400,
      message: '密码至少8位，且包含字母和数字'
    })
  }

  const db = getDb(event)

  if (!db) {
    throw createError({
      statusCode: 500,
      message: '数据库连接失败'
    })
  }
  const userService = new UserService(db)
  const user = await userService.getUserById(Number(authUserId))
  if (!user) {
    throw createError({
      statusCode: 404,
      message: '用户不存在'
    })
  }

  // 权限验证（后端也要校验，避免仅靠前端隐藏）。
  // 只有自助改密才要求原密码 —— adminMode 分支是管理员重置密码，设计如此，
  // 而 adminMode 为真意味着 getMeAndTargetStrict 已经验过角色与数据域。
  if (!adminMode)
  {
    const canChange = user.canChangePassword

    if (!canChange) {
      throw createError({ statusCode: 403, message: '无权限修改密码' })
    }
    const isValidPassword = await verifyPassword(currentPassword, user.password_hash || '')
    if (!isValidPassword) {
      throw createError({
        statusCode: 400,
        message: '当前密码不正确'
      })
    }
  }

  // 更新新密码
  const passwordHash = await hashPassword(newPassword)

  await db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(passwordHash, user.id)
    .run()
  if (!adminMode)
  {
    deleteCookie(event, 'auth-token')
  }

  return { success: true }
})