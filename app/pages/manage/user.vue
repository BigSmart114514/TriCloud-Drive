<template>
  <div class="min-h-screen bg-gray-50">
    <!-- 导航栏 -->
    <AppNavbar />

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
      <div v-else-if="!isAdmin" class="px-4 py-6 sm:px-0">
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
                class="w-72 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
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
                  class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">用户名</label>
                <input
                  v-model="addUsername"
                  type="text"
                  autocomplete="off"
                  class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                  placeholder="只能包含大小写字母和数字"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">密码</label>
                <input
                  v-model="addPassword"
                  type="password"
                  autocomplete="new-password"
                  class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
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
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">用户</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                  <th class="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr v-if="loading">
                  <td colspan="3" class="px-6 py-8 text-center text-sm text-gray-500">载入中...</td>
                </tr>
                <tr v-else-if="users.length === 0">
                  <td colspan="3" class="px-6 py-8 text-center text-sm text-gray-500">暂无数据</td>
                </tr>
                <tr
                  v-for="u in users"
                  :key="u.id"
                  class="cursor-pointer transition-colors hover:bg-gray-50"
                  :class="editingUser?.id === u.id ? 'bg-indigo-50/60' : ''"
                  @click="openEditor(u)"
                >
                  <td class="px-6 py-3 whitespace-nowrap">
                    <span class="flex items-center gap-2 text-sm font-medium text-gray-900">
                      <span class="truncate">{{ u.username || u.email || '未命名' }}</span>
                      <ShieldCheckIcon v-if="u.IsSuperAdmin" class="h-4 w-4 shrink-0 text-purple-500" title="超级管理员" />
                      <StarIcon v-else-if="u.IsAdmin" class="h-4 w-4 shrink-0 text-amber-500" title="管理员" />
                    </span>
                    <span v-if="u.email" class="mt-0.5 block truncate text-xs text-gray-500">{{ u.email }}</span>
                  </td>
                  <td class="px-6 py-3 whitespace-nowrap text-sm tabular-nums text-gray-500">{{ u.id }}</td>
                  <td class="px-6 py-3 whitespace-nowrap text-right">
                    <button
                      type="button"
                      class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white hover:text-indigo-600 hover:shadow-sm"
                      :aria-label="`编辑用户 ${u.username || u.email || u.id}`"
                      title="编辑"
                      @click.stop="openEditor(u)"
                    >
                      <PencilSquareIcon class="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 编辑弹窗 -->
        <UserEditDialog
          :open="!!editingUser"
          :user="editingUser"
          :read-only="!!editingUser && disableEditFor(editingUser)"
          :can-delete="!!editingUser && !disableDeleteFor(editingUser)"
          :can-grant-super="isSuper"
          :saving="updatingId === editingUser?.id"
          :deleting="deletingId === editingUser?.id"
          :changing-pwd="changingPwdId === editingUser?.id"
          @close="closeEditor"
          @save="saveUser"
          @delete="deleteEditingUser"
          @change-password="changePassword(editingUser!)"
        />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">

import { formatDateTime } from '~/utils/time'
import { notify, notifyError, toMessage } from '~/utils/notify'
import { formatBytes, parseBytes } from '~/utils/size'
import { fromDatetimeLocal, toDatetimeLocal } from '~/utils/datetimeLocal'
import { PencilSquareIcon, ShieldCheckIcon, StarIcon } from '@heroicons/vue/24/outline'
import UserEditDialog, { type DbUser } from '~/components/UserEditDialog.vue'

useHead({ title: '用户管理' })

// DbUser 现在由 UserEditDialog.vue 导出（类型跟着走，别在页面里再抄一份）

// 后端返回的原始用户类型（容量字段为数字，单位：字节）
type ApiUser = Omit<DbUser, 'usedStorage' | 'maxStorage' | 'usedDownload' | 'maxDownload'> & {
  usedStorage: number
  maxStorage: number
  usedDownload: number
  maxDownload: number
}

const { user, isLoggedIn, isAdmin, register} = useAuth()


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
    notify('密码已更新', 'success')
  } catch (err: any) {
    notifyError(err, '修改密码失败')
  } finally {
    changingPwdId.value = null
  }
}

const users = ref<DbUser[]>([])
const totalCount = ref(0)
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

// 「我是管理员」统一走 useAuth.isAdmin。原来的 canManage 是在 setup 里对
// user.value 取的一次性快照（ref），user 晚到一步就会永远停在 false；
// 换成 computed 后会跟着 user 实时更新。

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

/**
 * 「能不能改这一行」。与 disableDeleteFor 同一套角色规则，因为服务端
 * updateUser.post.ts 和 deleteUser.post.ts 现在是同一个模型：
 *   超管       → 任何人
 *   普通管理员 → 只能改普通用户，且不能把谁设为超管
 *
 * 连带效果：普通管理员**改不了自己那一行**（自己就是 IsAdmin=1），
 * 自己的配额/到期时间变只读。配额本质是超管授予的资源，自己改等于自批。
 *
 * 这里只是置灰，真正的拦截在服务端 —— 置灰是为了不让人点了才吃 403。
 */
const disableEditFor = (u: DbUser) => {
  if (!isSuper.value && (u.IsAdmin || u.IsSuperAdmin)) return true
  return false
}

const deleteUser = async (u: DbUser) => {
  if (disableDeleteFor(u)) return

  deletingId.value = u.id
  try {
    await $fetch('/api/manage/deleteUser', {
      method: 'POST',
      body: { id: u.id }
    })
    notify(`已删除用户「${u.username}」`, 'success')
    closeEditor()
    await fetchUsers()
  } catch (err: any) {
    notifyError(err, '删除失败')
  } finally {
    deletingId.value = null
  }
}


/* -------- 编辑弹窗 -------- */

// 正在编辑的行。null = 弹窗关闭。
// 弹窗内部会自己拷一份草稿，这里存的只是「原值」，用来显示和判断权限。
const editingUser = ref<DbUser | null>(null)

const openEditor = (u: DbUser) => {
  editingUser.value = u
}

const closeEditor = () => {
  if (updatingId.value !== null || deletingId.value !== null) return
  editingUser.value = null
}

// 弹窗里点「删除」→ 走 deleteUser
const deleteEditingUser = () => {
  if (!editingUser.value) return
  deleteUser(editingUser.value)
}


/* -------- 容量/时间格式化已移到 app/utils（size.ts / datetimeLocal.ts） -------- */

/* -------- 数据加载 -------- */

// 失败时只 console.error 不弹提示 —— 这是这一页的既有行为：管理员改别人的
// 额度，出错时表格还停着上一批数据，静默比弹一条「加载失败」更不打扰。
// （别的页面用默认的 notifyError。）
const { loading, reload: fetchUsers } = useAsyncResource(async () => {
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
    // 必须用 toDatetimeLocal，不能用 formatDateTime：后者输出的是
    // 「2026年1月1日 00:00」这种本地化字符串，datetime-local 认不出来，
    // 框里会显示为空，得手动重选一次才对。
    expire_at: toDatetimeLocal(u.expire_at)
  }))
  totalCount.value = resp.totalCount || 0
  lastRefreshed.value = new Date().toISOString()
}, {
  onError: (err) => console.error('获取用户失败:', err),
  immediate: true
})

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
    addError.value = toMessage(err, '创建失败')
  } finally {
    addLoading.value = false
  }
}

/* -------- 保存用户：接收弹窗草稿，解析后提交 -------- */

const saveUser = async (draft: DbUser) => {
  // 弹窗已经只读置灰了，这里是第二道 —— 服务端 updateUser.post.ts 同样会拦
  if (disableEditFor(draft)) {
    notify('普通管理员不能修改管理员或超级管理员', 'error')
    return
  }

  updatingId.value = draft.id
  try {
    await $fetch('/api/manage/updateUser', {
      method: 'POST',
      body: {
        id: draft.id,
        IsAdmin: draft.IsAdmin ? 1 : 0,
        IsSuperAdmin: draft.IsSuperAdmin ? 1 : 0,
        maxStorage: parseBytes(draft.maxStorage as string | number),
        usedStorage: parseBytes(draft.usedStorage as string | number),
        maxDownload: parseBytes(draft.maxDownload as string | number),
        usedDownload: parseBytes(draft.usedDownload as string | number),
        // 从 datetime-local 的 "T" 格式转回后端要的空格格式；空 = 永不过期
        expire_at: fromDatetimeLocal((draft.expire_at as string | null) ?? null),
        // 子账户能力。服务端用 COALESCE 兜底，所以这两位不传也不会被清零，
        // 但这里显式传，避免以后有人加个「只传部分字段」的调用点时忘了它。
        canSubAccount: draft.parent_id != null ? undefined : (draft.canSubAccount ? 1 : 0),
        maxSubAccount: draft.parent_id != null ? undefined : Number(draft.maxSubAccount ?? 0)
      }
    })

    notify('已保存', 'success')
    closeEditor()
    // 重新拉一遍，让列表显示的是服务端归一化后的值（比如「1024 kb」会存成 1 MB）
    await fetchUsers()
  } catch (err: any) {
    notifyError(err, '更新用户失败')
  } finally {
    updatingId.value = null
  }
}
// 标题用下面的 useHead。definePageMeta({ title }) 在 Nuxt 4 已经不写 <title> 了，别留着误导
definePageMeta({
  layout: false
})
</script>