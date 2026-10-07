export default defineNuxtRouteMiddleware(async (to) => {
  const { public: { allowRegister } } = useRuntimeConfig()
  const auth = useAuth()

  // 如果还没拉过用户信息（初始为 null），先尝试获取一次
  if (auth.user.value === null) {
    try { await auth.fetchUser() } catch { }
  }

  // 注册开关
  if (allowRegister === false && to.path === '/register') {
    if (!auth.isLoggedIn.value)
    {
      return navigateTo('/')
    }
    else if (!auth.user.value?.IsAdmin && !auth.user.value?.IsSuperAdmin)
    {
      return navigateTo('/')
    }
  }

  // 白名单只留现役页面。app/pages/old/ 下的 loginold / registerold 已删除
  // （功能被 login.vue / register.vue 取代，且全项目没有任何入口链接它们），
  // 所以这里原先那两项一并去掉 —— 留着会让已登录用户访问 /old/* 时不被重定向，
  // 而那些路由已经 404，属于白名单里的幽灵条目。
  const whitelist = new Set(['/', '/login', '/register'])

  // 未登录且不在白名单 => 去登录
  if (!auth.isLoggedIn.value && !whitelist.has(to.path)) {
    return navigateTo('/login')
  }

  // 可选：已登录就别进登录页
  if (auth.isLoggedIn.value && whitelist.has(to.path) && to.path === '/login') {
    return navigateTo('/')
  }

  // 管理后台页面：非管理员直接送回首页。
  // 原来这里只判了 '/api/manage'，那是 API 前缀，而页面路由是 '/manage/files'、
  // '/manage/user'，startsWith 永远匹配不上 —— 于是这两个页面对非管理员是放行的：
  // files.vue 靠客户端 navigateTo 兜（SSR 阶段仍然整页渲染出来），
  // user.vue 连客户端守卫都没有，进去就是一屏 403。
  if (to.path === '/manage' || to.path.startsWith('/manage/')) {
    if (!(auth.user.value?.IsAdmin || auth.user.value?.IsSuperAdmin)) {
      return navigateTo('/')
    }
    // 存储桶管理要**超管**，比上面那两级更严。
    //
    // 为什么必须在这里单独判：管理后台其余页面对管理员开放，而这个页面的两个
    // 删除方向都是不可逆的（孤儿对象删掉字节没了，悬空行删掉文件名/位置/时间
    // 没了）。只靠服务端 requireSuperAdmin 的话，普通管理员进去就是一屏 403，
    // 而 UiManageMenu 已经不会给他这个入口 —— 相当于两层都拦：
    // 菜单不给（体验），这里不给（SSR 阶段就拦，不发出请求），服务端不给（真边界）。
    if (to.path === '/manage/bucket' && !auth.user.value?.IsSuperAdmin) {
      return navigateTo('/manage/files')
    }
  }

  if (!(auth.user.value?.IsAdmin || auth.user.value?.IsSuperAdmin) && to.path.startsWith('/api/manage') )
  {
    throw createError({ statusCode: 400, statusMessage: 'You are not authorized to access this page' })
  }
})