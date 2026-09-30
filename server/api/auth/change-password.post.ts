// server/api/auth/change-password.post.ts
import { readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireAuth, getMeAndTarget } from '~~/server/utils/auth-middleware'
import { validatePassword, verifyPassword, hashPassword } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  //const user = await requireAuth(event, { withUser: true } )
  const { me, targetUserId } = await getMeAndTarget(event)
  
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
  const user = await userService.getUserById(Number(targetUserId))
  if (!user) {
    throw createError({
      statusCode: 500,
      message: '用户查询失败'
    })
  }
  

  // 权限验证（后端也要校验，避免仅靠前端隐藏）
  if (me.userId === targetUserId)
  {
    //console.log(me.userId,targetUserId)
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
  if (me.userId === targetUserId)
  {
    deleteCookie(event, 'auth-token')
  }

  return { success: true }
})