import { UserService } from '~~/server/utils/db'
import { verifyPassword, generateToken, validateEmail, validateUsername } from '~~/server/utils/auth'
import { getDb } from '~~/server/utils/db-adapter'
export default defineEventHandler(async (event) => {
  if (getMethod(event) !== 'POST') {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed'
    })
  }

  try {
    const { username, password } = await readBody(event)

    // 验证输入
    if (!password || !username) {
      throw createError({
        statusCode: 400,
        message: '用户名和密码都是必填项'
      })
    }

    if (!validateUsername(username)) {
      throw createError({
        statusCode: 400,
        message: '用户名格式不正确'
      })
    }

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

    // 查找用户
    const user = await userService.getUserByUsername(username)
    if (!user) {
      throw createError({
        statusCode: 401,
        message: '用户名或密码错误'
      })
    }

    // 验证密码
    const isValidPassword = await verifyPassword(password, user.password_hash)
    if (!isValidPassword) {
      throw createError({
        statusCode: 401,
        message: '用户名或密码错误'
      })
    }

    // 生成 JWT token
    const config = useRuntimeConfig()
    const token = generateToken(user.id, config.sessionSecret)

    // 设置 HttpOnly cookie
    setCookie(event, 'auth-token', token, {
      httpOnly: true,
      secure: !!config.https,
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 7 // 7 days
    })

    return {
      success: true,
      statusMessage: '登录成功',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        created_at: user.created_at
      }
    }
  } catch (error: any) {
    if (error.statusCode) {
      throw error
    }
    
    console.error('Login error:', error)
    throw createError({
      statusCode: 500,
      message: '服务器内部错误'
    })
  }
})
