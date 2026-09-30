import { UserService } from '~~/server/utils/db'
import { hashPassword, validateEmail, validatePassword, validateUsername } from '~~/server/utils/auth'
import { getDb } from '~~/server/utils/db-adapter'
import { optionalAuth } from '~~/server/utils/auth-middleware'
import { common403Error, common405Error, dbConnectionError, common500Error } from '~~/types/error'
export default defineEventHandler(async (event) => {
  if (getMethod(event) !== 'POST') {
    throw common405Error
  }
  const config = useRuntimeConfig()
  // allowRegister 定义在 runtimeConfig.public 下，取值必须带 public，
  // 对应环境变量是 NUXT_PUBLIC_ALLOW_REGISTER。原先写成 config.allowRegister
  // 恒为 undefined，等于注册接口对所有人永久关闭（含管理员自己）。
  if (config.public.allowRegister !== true) {
    // 注册开关关着时给管理员开口子：否则开关一关，
    // 连唯一有权限再开账号的人都没法通过这个接口建人
    // withUser 必须为 true，否则拿不到 isAdmin / isSuperAdmin
    const me = await optionalAuth(event, { withUser: true })
    if (!me?.isAdmin && !me?.isSuperAdmin) throw common403Error
  }

  try {
    const { email, username, password } = await readBody(event)

    // 验证输入
    if (!email || !password || !username) {
      throw createError({
        statusCode: 400,
        statusMessage: '邮箱,用户名,密码暂时都是必填项'
      })
    }

    if (!validateEmail(email)) {
      throw createError({
        statusCode: 400,
        statusMessage: '邮箱格式不正确'
      })
    }

    if (!validatePassword(password)) {
      throw createError({
        statusCode: 400,
        statusMessage: '密码至少8位，且包含字母和数字'
      })
    }
    if (!validateUsername(username)) {
      throw createError({
        statusCode: 400,
        statusMessage: '用户名格式不正确,暂时只能包含大小写字母和数字'
      })
    }

    // 获取数据库连接
    //const db = event.context.cloudflare?.env?.DB
    const db = getDb(event)
    if (!db) {
      throw dbConnectionError
    }

    const userService = new UserService(db)

    // 检查用户是否已存在
    const existingUser = await userService.getUserByUsername(username)
    if (existingUser) {
      throw createError({
        statusCode: 409,
        statusMessage: '该用户名已被注册'
      })
    }

    // 创建新用户
    const passwordHash = await hashPassword(password)
    const newUser = await userService.createUser(email, username, passwordHash)

    if (!newUser) {
      throw createError({
        statusCode: 500,
        statusMessage: '用户创建失败'
      })
    }

    return {
      success: true,
      statusMessage: '注册成功',
      user: {
        id: newUser.id,
        email: newUser.email,
        username: newUser.username,
        created_at: newUser.created_at
      }
    }
  } catch (error: any) {
    if (error.statusCode) {
      throw error
    }
    
    console.error('Registration error:', error)
    throw common500Error
  }
})
