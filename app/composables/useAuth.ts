export const useAuth = () => {
  const user = useState<User | null>('auth.user', () => null)
  const isLoggedIn = computed(() => !!user.value)

  /**
   * 能不能进 /manage/*。管理后台页面上到处要用这个判断，之前是每个页面各写一遍，
   * 这里收成一份。小写 isAdmin / isSuperAdmin 是旧接口的字段名，保留兼容。
   *
   * 只用于「前端决定要不要显示入口」；真正的拦截在 auth.global.ts（页面路由）
   * 和 server/middleware/01.api-auth.ts（/api/manage/**）两处。
   */
  const isAdmin = computed(() => {
    const u = user.value as (User & { isAdmin?: boolean; isSuperAdmin?: boolean }) | null
    return !!(u && (u.IsAdmin || u.IsSuperAdmin || u.isAdmin || u.isSuperAdmin))
  })

  const login = async (username: string, password: string) => {
    const data = await $fetch<{ success: boolean; user: User; message: string }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
      credentials: 'include'
    })
    if (data.success) user.value = data.user
    return data
  }

  const register = async (email: string, username: string, password: string) => {
    const data = await $fetch<{ success: boolean; user: User; message: string }>('/api/auth/register', {
      method: 'POST',
      body: { email, username, password },
      credentials: 'include'
    })
    return data
  }

  const logout = async () => {
    await $fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    user.value = null
    await navigateTo('/login')
  }

  const fetchUser = async () => {
    try {
      const headers = process.server ? useRequestHeaders(['cookie']) : undefined
      const data = await $fetch<{ success: boolean; user: User | null }>('/api/auth/me', {
        headers,
        credentials: 'include'
      })
      user.value = data.success ? data.user : null
    } catch {
      user.value = null
    }
  }

  return {
    user: readonly(user),
    isLoggedIn,
    isAdmin,
    login,
    register,
    logout,
    fetchUser,
  }
}