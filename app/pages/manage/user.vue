<template>
  <div class="min-h-screen bg-gray-50">
    <!-- 导航栏 -->
    <AppNavbar>
      <template #extra>
        <NuxtLink
          to="/"
          class="flex items-center rounded-md p-2 text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 sm:px-3 sm:py-2 sm:text-sm sm:font-medium"
          aria-label="返回首页"
          title="返回首页"
        >
          <HomeIcon class="h-5 w-5 shrink-0" />
          <span class="hidden sm:ml-1.5 sm:inline">返回首页</span>
        </NuxtLink>
      </template>
    </AppNavbar>

    <!-- 主内容 -->
    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <!-- 未登录 -->
      <div v-if="!isLoggedIn" class="px-4 py-6 sm:px-0">
        <div class="text-center">
          <h2 class="text-2xl font-bold text-gray-900">请先登录</h2>
          <div class="mt-4">
            <NuxtLink
              to="/login"
              class="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
            >
              去登录
            </NuxtLink>
          </div>
        </div>
      </div>

      <!-- 已登录但无权限 -->
      <div v-else-if="!canManage" class="px-4 py-6 sm:px-0">
        <div class="bg-yellow-50 border-l-4 border-yellow-400 p-4">
          <div class="flex">
            <div class="ml-3">
              <p class="text-sm text-yellow-700">
                当前账号没有访问“用户管理”的权限，请联系管理员。
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 管理页面 -->
      <div v-else class="px-4 py-6 sm:px-0">
        <!-- 顶部工具栏 -->
        <div class="mb-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <h2 class="text-2xl font-bold text-gray-900">用户管理</h2>
          <div class="flex flex-wrap items-center gap-3">
            <div class="relative">
              <input
                v-model="filters.username"
                @keyup.enter="fetchUsers"
                type="text"
                placeholder="按用户名搜索"
                class="w-72 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm"
              />
            </div>
            <button
              @click="fetchUsers"
              class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-sm font-medium"
              :disabled="loading"
            >
              搜索
            </button>
            <button
              @click="resetFilters"
              class="bg-white hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-md text-sm border"
              :disabled="loading"
            >
              重置
            </button>
            <button
              @click="fetchUsers"
              class="bg-white hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-md text-sm border"
              :disabled="loading"
            >
              刷新
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <!-- 添加用户 -->
          <div class="bg-white shadow rounded-lg p-6">
            <h3 class="text-lg font-medium text-gray-900 mb-4">添加用户</h3>
            <form @submit.prevent="handleAddUser" class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700">邮箱</label>
                <input
                  v-model="addEmail"
                  type="email"
                  autocomplete="off"
                  class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">用户名</label>
                <input
                  v-model="addUsername"
                  type="text"
                  autocomplete="off"
                  class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  placeholder="只能包含大小写字母和数字"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">密码</label>
                <input
                  v-model="addPassword"
                  type="password"
                  autocomplete="new-password"
                  class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  placeholder="至少8位，包含字母和数字"
                />
              </div>
              <div class="flex items-center gap-3">
                <button
                  type="submit"
                  class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-sm font-medium"
                  :disabled="addLoading"
                >
                  {{ addLoading ? '创建中...' : '创建用户' }}
                </button>
                <p v-if="addMessage" class="text-sm text-green-600">{{ addMessage }}</p>
                <p v-if="addError" class="text-sm text-red-600">{{ addError }}</p>
              </div>
            </form>
          </div>

          <!-- 简要统计 -->
          <div class="bg-white shadow rounded-lg p-6">
            <h3 class="text-lg font-medium text-gray-900 mb-4">概览</h3>
            <dl class="space-y-3">
              <div>
                <dt class="text-sm font-medium text-gray-500">用户总数</dt>
                <dd class="text-2xl font-semibold text-gray-900">{{ totalCount }}</dd>
              </div>
              <div v-if="loading" class="text-sm text-gray-500">正在加载用户数据...</div>
              <div v-else class="text-sm text-gray-500">最近刷新：{{ lastRefreshed ? formatDateTime(lastRefreshed) : '—' }}</div>
            </dl>
          </div>
        </div>

        <!-- 用户列表 -->
        <div class="bg-white shadow rounded-lg overflow-hidden">
          <div class="px-6 py-4 border-b">
            <h3 class="text-lg font-medium text-gray-900">用户列表</h3>
          </div>

          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">邮箱</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">用户名</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">注册时间</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">套餐过期时间</th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">管理员</th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">超级管理员</th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">容量限制</th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">容量已使用</th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">下载限制</th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">下载已使用</th>
                  
                  <th class="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr v-if="loading">
                  <td colspan="12" class="px-6 py-8 text-center text-sm text-gray-500">载入中...</td>
                </tr>
                <tr v-else-if="users.length === 0">
                  <td colspan="12" class="px-6 py-8 text-center text-sm text-gray-500">暂无数据</td>
                </tr>
                <tr v-for="u in users" :key="u.id">
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{{ u.id }}</td>
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{{ u.email }}</td>
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{{ u.username }}</td>
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{{ formatDateTime(u.created_at) }}</td>
                  <!-- 套餐过期时间 -->
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <input
                      type="datetime-local"
                      v-model="u.expire_at"
                      @blur="normalizeExpireAt(u)"
                      :disabled="updatingId === u.id"
                      class="w-56 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      step="1"
                      title="选择日期时间；清空表示不过期"
                    />
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap">
                    <div class="flex justify-center">
                      <input
                        type="checkbox"
                        v-model="u.IsAdmin"
                        :disabled="updatingId === u.id"
                        class="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                      />
                    </div>
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap">
                    <div class="flex justify-center">
                      <input
                        type="checkbox"
                        v-model="u.IsSuperAdmin"
                        :disabled="updatingId === u.id"
                        class="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                      />
                    </div>
                  </td>

                  <!-- 容量限制（可编辑） -->
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <input
                      type="text"
                      v-model="u.maxStorage"
                      @blur="normalizeSizeField(u, 'maxStorage')"
                      :disabled="updatingId === u.id"
                      class="w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      placeholder="如 10 GB"
                      inputmode="decimal"
                      autocomplete="off"
                      title="支持单位：B, KB, MB, GB, TB"
                    />
                  </td>

                  <!-- 容量已使用（可编辑） -->
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <input
                      type="text"
                      v-model="u.usedStorage"
                      @blur="normalizeSizeField(u, 'usedStorage')"
                      :disabled="updatingId === u.id"
                      class="w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      placeholder="如 512 MB"
                      inputmode="decimal"
                      autocomplete="off"
                      title="支持单位：B, KB, MB, GB, TB"
                    />
                  </td>

                  <!-- 下载限制（可编辑） -->
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <input
                      type="text"
                      v-model="u.maxDownload"
                      @blur="normalizeSizeField(u, 'maxDownload')"
                      :disabled="updatingId === u.id"
                      class="w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      placeholder="如 100 GB"
                      inputmode="decimal"
                      autocomplete="off"
                      title="支持单位：B, KB, MB, GB, TB"
                    />
                  </td>

                  <!-- 下载已使用（可编辑） -->
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <input
                      type="text"
                      v-model="u.usedDownload"
                      @blur="normalizeSizeField(u, 'usedDownload')"
                      :disabled="updatingId === u.id"
                      class="w-40 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      placeholder="如 1.5 GB"
                      inputmode="decimal"
                      autocomplete="off"
                      title="支持单位：B, KB, MB, GB, TB"
                    />
                  </td>

                  <td class="px-6 py-4 whitespace-nowrap text-right text-sm space-x-2">
                    <button
                      @click="changePassword(u)"
                      :disabled="changingPwdId === u.id"
                      class="bg-white hover:bg-gray-50 text-gray-700 px-3 py-1.5 rounded-md text-sm border"
                    >
                      {{ changingPwdId === u.id ? '修改中...' : '修改密码' }}
                    </button>

                    <button
                      @click="saveUser(u)"
                      :disabled="updatingId === u.id"
                      class="bg-white hover:bg-gray-50 text-gray-700 px-3 py-1.5 rounded-md text-sm border"
                    >
                      {{ updatingId === u.id ? '保存中...' : '保存' }}
                    </button>

                    <button
                      @click="deleteUser(u)"
                      :disabled="deletingId === u.id || disableDeleteFor(u)"
                      class="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md text-sm"
                    >
                      {{ deletingId === u.id ? '删除中...' : '删除' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { formatDateTime } from '~/utils/time'
import { notify } from '~/utils/notify'
import { HomeIcon } from '@heroicons/vue/24/outline'

type DbUser = {
  id: number
  email: string
  username: string
  created_at: string
  IsAdmin: number | boolean
  IsSuperAdmin: number | boolean
  // 允许字符串（用于显示带单位），保存时会解析为字节数
  usedStorage: number | string
  maxStorage: number | string
  usedDownload: number | string
  maxDownload: number | string
  expire_at: string | null
}

// 后端返回的原始用户类型（容量字段为数字，单位：字节）
type ApiUser = Omit<DbUser, 'usedStorage' | 'maxStorage' | 'usedDownload' | 'maxDownload'> & {
  usedStorage: number
  maxStorage: number
  usedDownload: number
  maxDownload: number
}

const { user, isLoggedIn, register} = useAuth()


// 修改密码中的用户 ID
const changingPwdId = ref<number | null>(null)

const changePassword = async (u: DbUser) => {
  if (!u?.id) return

  const input = window.prompt(`为用户「${u.username}」设置新密码（至少8位，包含字母和数字）：`, '')
  if (input === null) return // 取消
  const newPassword = input.trim()

  // 简单校验：至少8位，且包含字母和数字
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    notify('密码不符合要求：至少8位，且需包含字母和数字','error')
    return
  }

  changingPwdId.value = u.id
  try {
    await $fetch('/api/auth/change-password/', {
      method: 'POST',
      body: {
        targetUserId: u.id,
        newPassword
      }
    })
    notify('密码已更新','success')
  } catch (err: any) {
    const msg = err?.data?.statusMessage || '修改密码失败'
    notify(msg, 'error')
  } finally {
    changingPwdId.value = null
  }
}

const users = ref<DbUser[]>([])
const totalCount = ref(0)
const loading = ref(false)
const lastRefreshed = ref<string | null>(null)

const filters = reactive({
  email: '',
  username: ''
})

// 添加用户表单
const addEmail = ref('')
const addUsername = ref('')
const addPassword = ref('')
const addLoading = ref(false)
const addMessage = ref('')
const addError = ref('')

const updatingId = ref<number | null>(null)

const canManage = ref(!!user.value?.IsAdmin || !!user.value?.IsSuperAdmin)

// 删除相关状态
const deletingId = ref<number | null>(null)

// 当前登录用户角色（用于前端控制按钮状态；最终以服务端为准）
const isSuper = computed(() => !!user.value?.IsSuperAdmin)
const isAdminOnly = computed(() => !!user.value?.IsAdmin && !isSuper.value)

// 前端禁用删除的规则（仅前端保护，服务端仍严格校验）
const disableDeleteFor = (u: DbUser) => {
  if (u.id === user.value?.id) return true
  if (isAdminOnly.value && (u.IsAdmin || u.IsSuperAdmin)) return true
  return false
}

const deleteUser = async (u: DbUser) => {
  if (disableDeleteFor(u)) return
  const ok = window.confirm(`确认删除用户「${u.username}」及其全部文件吗？此操作不可恢复！`)
  if (!ok) return

  deletingId.value = u.id
  try {
    await $fetch('/api/manage/deleteUser', {
      method: 'POST',
      body: { id: u.id }
    })
    await fetchUsers()
  } catch (err: any) {
    const msg = err?.data?.statusMessage || '删除失败'
    notify(msg, 'error')
  } finally {
    deletingId.value = null
  }
}


/* -------- 工具：容量格式化/解析 -------- */

// 把字节转成人类可读的字符串（B/KB/MB/GB/TB）
const formatBytes = (bytes: number): string => {
  if (!isFinite(bytes) || isNaN(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  const display =
    val >= 100 ? Math.round(val) :
    val >= 10 ? Math.round(val * 10) / 10 :
    Math.round(val * 100) / 100
  return `${display} ${units[i]}`
}

// 把字符串（可带单位）解析为字节数，支持：B/KB/MB/GB/TB、大小写、可省略 B
const parseBytes = (input: string | number): number => {
  if (typeof input === 'number') return Math.max(0, Math.round(input))
  if (!input) return 0
  let str = String(input).trim()
  if (!str) return 0

  // 处理中英文逗号、小写空格
  str = str.replace(/，/g, ',').replace(',', '.').replace(/\s+/g, ' ')
  const match = str.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/)
  if (!match) return 0

  let value = parseFloat(match[1])
  let unit = (match[2] || '').toLowerCase()

  if (isNaN(value) || value < 0) value = 0

  let mult = 1
  if (!unit || unit === 'b') mult = 1
  else if (unit.startsWith('k')) mult = 1024
  else if (unit.startsWith('m')) mult = 1024 ** 2
  else if (unit.startsWith('g')) mult = 1024 ** 3
  else if (unit.startsWith('t')) mult = 1024 ** 4
  else mult = 1 // 未识别单位按字节处理

  const bytes = Math.round(value * mult)
  return bytes < 0 ? 0 : bytes
}

// 输入失焦时，把用户输入规范化为标准显示（如 1024 kb -> 1 MB）
type SizeKey = 'maxStorage' | 'usedStorage' | 'maxDownload' | 'usedDownload'
const normalizeSizeField = (u: DbUser, key: SizeKey) => {
  const bytes = parseBytes(u[key] as string | number)
  u[key] = formatBytes(bytes)
}

/* -------- 数据加载 -------- */

const fetchUsers = async () => {
  loading.value = true
  try {
    const resp = await $fetch<{ users: ApiUser[]; totalCount: number }>('/api/manage/listUsers', {
      query: filters.username ? { username: filters.username } : {}
    })
    users.value = (resp.users || []).map((u) => ({
      ...u,
      IsAdmin: !!u.IsAdmin,
      IsSuperAdmin: !!u.IsSuperAdmin,
      usedStorage: formatBytes(Number(u.usedStorage ?? 0)),
      maxStorage: formatBytes(Number(u.maxStorage ?? 0)),
      usedDownload: formatBytes(Number(u.usedDownload ?? 0)),
      maxDownload: formatBytes(Number(u.maxDownload ?? 0)),
      expire_at: u.expire_at ? formatDateTime(u.expire_at) : ''
    }))
    totalCount.value = resp.totalCount || 0
    lastRefreshed.value = new Date().toISOString()
  } catch (err) {
    console.error('获取用户失败:', err)
  } finally {
    loading.value = false
  }
}

onMounted(fetchUsers)

const resetFilters = () => {
  filters.email = ''
  filters.username = ''
  fetchUsers()
}

/* -------- 添加用户保持不变 -------- */

const handleAddUser = async () => {
  addError.value = ''
  addMessage.value = ''

  if (!addEmail.value || !addPassword.value) {
    addError.value = '请输入邮箱和密码'
    return
  }

  addLoading.value = true
  try {
    await register(addEmail.value, addUsername.value, addPassword.value)
    addMessage.value = '用户创建成功'
    addEmail.value = ''
    addUsername.value = ''
    addPassword.value = ''
    await fetchUsers()
  } catch (err: any) {
    addError.value = err?.data?.statusMessage || '创建失败'
  } finally {
    addLoading.value = false
  }
}

/* -------- 保存用户：解析输入为字节数后提交 -------- */

const saveUser = async (u: DbUser) => {
  try {
    updatingId.value = u.id

    // 从 datetime-local 字符串转回 "YYYY-MM-DD HH:mm:ss"（或 null）
    const normalizedExpire = fromDatetimeLocal((u.expire_at as string | null) ?? null)

    const payload = {
      id: u.id,
      IsAdmin: u.IsAdmin ? 1 : 0,
      IsSuperAdmin: u.IsSuperAdmin ? 1 : 0,
      maxStorage: parseBytes(u.maxStorage as string | number),
      usedStorage: parseBytes(u.usedStorage as string | number),
      maxDownload: parseBytes(u.maxDownload as string | number),
      usedDownload: parseBytes(u.usedDownload as string | number),
      expire_at: normalizedExpire // 传给后端的仍是空格分隔格式
    }

    await $fetch('/api/manage/updateUser', {
      method: 'POST',
      body: payload
    })

    // 保存成功后，把显示值转回 datetime-local 需要的格式
    u.maxStorage = formatBytes(payload.maxStorage)
    u.usedStorage = formatBytes(payload.usedStorage)
    u.maxDownload = formatBytes(payload.maxDownload)
    u.usedDownload = formatBytes(payload.usedDownload)
    u.expire_at = payload.expire_at ? toDatetimeLocal(payload.expire_at) : ''
  } catch (err) {
    console.error('更新用户失败:', err)
    await fetchUsers()
  } finally {
    updatingId.value = null
  }
}
/* -------- 工具：过期时间处理 -------- */

const pad2 = (n: number) => String(n).padStart(2, '0')

// 仅接受 YYYY-MM-DD HH:mm:ss（或中间用 T）的字符串，返回规范化字符串或 null（空/无效）
const parseExpireAt = (val: string | null): string | null => {
  if (!val) return null
  const s = String(val).trim()
  if (!s) return null

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null

  const [y, mo, d, h, mi, se] = m.slice(1).map(Number)
  const date = new Date(y, mo - 1, d, h, mi, se)

  // 反校验，避免 2025-02-31 这种非法日期
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi ||
    date.getSeconds() !== se
  ) {
    return null
  }

  return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se)}`
}

// 输入框失焦时规范化显示（或提示）
const normalizeExpireAt = (u: DbUser) => {
  const raw = (u.expire_at ?? '').toString().trim()
  if (!raw) {
    u.expire_at = ''
    return
  }
  const normalized = fromDatetimeLocal(raw)
  if (!normalized) {
    notify('过期时间无效，请重新选择', 'error')
    u.expire_at = ''
    return
  }
  // 保持为 datetime-local 需要的格式（带 T，含秒）
  u.expire_at = normalized.replace(' ', 'T')
}
// 把 "YYYY-MM-DD HH:mm:ss"/"YYYY-MM-DDTHH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss"
const toDatetimeLocal = (val: string | null): string => {
  if (!val) return ''
  const s = String(val).trim()
  if (!s) return ''
  const normalized = parseExpireAt(s) // 返回 "YYYY-MM-DD HH:mm:ss" 或 null
  if (!normalized) return ''
  return normalized.replace(' ', 'T')
}

// 把 "YYYY-MM-DDTHH:mm[:ss]" -> "YYYY-MM-DD HH:mm:ss"（给后端）
const fromDatetimeLocal = (val: string | null): string | null => {
  if (!val) return null
  const s = String(val).trim()
  if (!s) return null
  // 若无秒，补 ":00"
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s + ':00' : s
  return parseExpireAt(withSeconds) // 返回 "YYYY-MM-DD HH:mm:ss" 或 null
}

definePageMeta({
  layout: false
})
</script>