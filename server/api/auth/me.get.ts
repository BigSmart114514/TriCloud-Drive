import { UserService } from '~~/server/utils/db'
import { requireAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
export default defineEventHandler(async (event) => {
  try {
    // 验证用户认证
    const authUser = await requireAuth(event)

    // 获取数据库连接
    //const db = event.context.cloudflare?.env?.DB
    const db = getDb(event)
    if (!db) {
      throw createError({
        statusCode: 500,
        message: '数据库连接失败'
      })
    }

    const userService = new UserService(db)

    // 获取用户信息
    const user = await userService.getUserById(authUser.userId)
    if (!user) {
      throw createError({
        statusCode: 404,
        message: '用户不存在'
      })
    }

    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        created_at: user.created_at,
        IsAdmin: user.IsAdmin,
        IsSuperAdmin: user.IsSuperAdmin,
        usedStorage: user.usedStorage,
        maxStorage: user.maxStorage,
        usedDownload: user.usedDownload,
        maxDownload: user.maxDownload,
        expire_at: user.expire_at,
        canChangePassword: user.canChangePassword,
      }
    }
  } catch (error: any) {
    if (error.statusCode) {
      throw error
    }
    
    console.error('Get user error:', error)
    throw createError({
      statusCode: 500,
      message: '服务器内部错误'
    })
  }
})
