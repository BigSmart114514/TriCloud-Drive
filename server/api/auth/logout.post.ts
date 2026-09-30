export default defineEventHandler(async (event) => {
  if (getMethod(event) !== 'POST') {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed'
    })
  }

  // 删除认证 cookie
  deleteCookie(event, 'auth-token')

  return {
    success: true,
    statusMessage: '退出登录成功'
  }
})
