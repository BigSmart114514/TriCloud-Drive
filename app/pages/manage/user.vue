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

          <!--
            简要统计。

            两个环的数据来自**已经在内存里的 users**：`/api/manage/listUsers`
            早就返回了每个用户的 usedStorage / usedDownload，而且没有
            LIMIT/OFFSET（全量）。所以这里不发第二个请求 —— 两份可能不一致的
            数据源比慢一点更糟。

            环会跟着上面的搜索框一起变。这不是新引入的不一致：面板里原有的
            「用户总数」本来就来自同一个响应、同一个过滤。

            配色由 assignColors 从**两个环的切片一起**分配，所以同一个用户在
            两个环里是同一个颜色 —— 否则 BigSmart 在左边蓝、右边橙，一眼
            扫过去像两个人。图例每个环一份，跟着自己的切片走。
          -->
          <div class="bg-white shadow rounded-lg p-6">
            <div class="mb-4 flex items-baseline justify-between gap-3">
              <h3 class="text-lg font-medium text-gray-900">概览</h3>
              <span class="text-xs text-gray-500">
                {{ loading ? '正在加载用户数据...' : `最近刷新：${lastRefreshed ? formatDateTime(lastRefreshed) : '—'}` }}
              </span>
            </div>

            <div class="mb-5 flex flex-wrap items-end gap-x-6 gap-y-1">
              <div>
                <p class="text-sm font-medium text-gray-500">用户总数</p>
                <p class="text-2xl font-semibold text-gray-900">{{ totalCount }}</p>
              </div>
              <!--
                零值用户单独说一句，不进环。零值若进环，每个都「小于 2%」，
                于是全被折进「其他」，得到一条「其他: 0 B，占 0%」—— 最蠢的一种
                图例，而且它把「有 6 个用户在用」这件事整个藏起来了。
              -->
              <p v-if="storageDonut.zeroCount" class="pb-1 text-xs text-gray-500">
                另有 {{ storageDonut.zeroCount }} 个用户没有用量
              </p>
              <!--
                读不出来的必须喊出来。上一轮这张图是空的、提示「另有 7 个用户没有
                用量」，而真相是「一个都没读出来」—— 两句话在屏幕上一模一样，
                所以这次让它自己说。
              -->
              <p v-if="unreadableUsage.length" class="pb-1 text-xs text-amber-700">
                有 {{ unreadableUsage.length }} 个用户的用量读不出数字，未计入
                （{{ unreadableUsage.join('、') }}）
              </p>
            </div>

            <div class="flex flex-wrap gap-8">
              <div v-for="ring in rings" :key="ring.title" class="min-w-0">
                <DonutChart
                  :slices="ring.slices"
                  :total="ring.total"
                  :colors="chartColors"
                  :title="ring.title"
                />
                <ul class="mt-3 min-w-[13rem] space-y-1 text-xs">
                  <li
                    v-for="s in ring.slices"
                    :key="s.key"
                    class="flex items-center gap-1.5"
                  >
                    <span
                      class="h-2 w-2 shrink-0 rounded-sm"
                      :style="{ backgroundColor: chartColors[s.key] }"
                    />
                    <span class="min-w-0 flex-1 truncate text-gray-600" :title="s.label">
                      {{ s.label }}
                    </span>
                    <span class="shrink-0 tabular-nums text-gray-500">
                      {{ formatFileSize(s.value) }}
                    </span>
                    <span class="w-9 shrink-0 text-right tabular-nums text-gray-400">
                      {{ Math.round(s.share * 100) }}%
                    </span>
                  </li>
                </ul>
              </div>
            </div>
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
import { askNewPassword } from '~/utils/password'
import { formatBytes, parseBytes } from '~/utils/size'
import { formatFileSize } from '~/utils/format'
import { assignColors, buildDonut, toDonutItems } from '~/utils/donut'
import { fromDatetimeLocal, toDatetimeLocal } from '~/utils/datetimeLocal'
import { PencilSquareIcon, ShieldCheckIcon, StarIcon } from '@heroicons/vue/24/outline'
import UserEditDialog, { type DbUser } from '~/components/UserEditDialog.vue'
// 显式 import，与同目录的 manage/files.vue、manage/bucket.vue 一致。
// 存储桶那个页面渲染时真的报过 `useAuth is not defined` 的 SSR 500 ——
// `useAuth` 在自动导入清单里，但注入没生效，原因没查清，所以管理页一律不赌它。
import { useAuth } from '~/composables/useAuth'

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

  const newPassword = await askNewPassword(`用户「${u.username}」`)
  if (newPassword === null) return // 取消

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

/**
 * 两个环的数据源，就是上面这份 users。
 *
 * 读的是 **usedStorageBytes / usedDownloadBytes** 这两个数值字段，不是
 * `usedStorage`。后者在下面 fetchUsers 里被 `formatBytes` 覆盖成了显示字符串
 * （"9.37 KB"）—— 那是给 UserEditDialog 的「已使用」输入框用的，删不得。
 * 而环需要字节：`Number("9.37 KB")` 是 NaN，`NaN || 0` 就是 0，于是整张图
 * 画成两个空圈 + 「另有 N 个用户没有用量」，而真相是「读错了」。
 *
 * 数值字段在 fetchUsers 里、**格式化之前**取好，格式化的结果一个字节都不准
 * （formatBytes 会四舍五入：9598 → "9.37 KB"，再 parse 回来是 9594.88）。
 */
const storageDonut = computed(() =>
  buildDonut(toDonutItems(users.value as never, 'usedStorageBytes').items)
)
const downloadDonut = computed(() =>
  buildDonut(toDonutItems(users.value as never, 'usedDownloadBytes').items)
)

/**
 * 读不出数字的用户名。两个环都要看，因为两个字段可能只有一个坏了 ——
 * 那种情况下只报一次就够了，所以取并集。
 */
const unreadableUsage = computed(() => [
  ...new Set([
    ...toDonutItems(users.value as never, 'usedStorageBytes').unreadable,
    ...toDonutItems(users.value as never, 'usedDownloadBytes').unreadable
  ])
])

/**
 * 顺序固定为「存储、下载」，图例也按这个顺序从左到右，所以同一个用户在两个
 * 环里拿到同一个颜色。
 */
const rings = computed(() => [
  { title: '存储空间', ...storageDonut.value },
  { title: '下载流量', ...downloadDonut.value }
])

/** 两个环**一起**分配颜色 —— 只传一个的话，下载环里靠前排名的用户会拿到自己的
 *  颜色，同一个用户于是左右不同色。 */
const chartColors = computed(() => assignColors(storageDonut.value.slices, downloadDonut.value.slices))
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
    // 数值字段必须在下面四行 formatBytes **之前**取好。
    //
    // 下面四个字段是显示字符串，UserEditDialog 的「已使用」输入框直接 v-model
    // 绑它们，所以不能改回数字。但环需要字节，而
    // `parseBytes(formatBytes(n))` 会丢精度（9598 → "9.37 KB" → 9594.88），
    // 所以只能在这里、格式化之前留一份原值。
    //
    // 第一版没有这个字段，环去读格式化后的 `usedStorage`，
    // Number("9.37 KB") = NaN → 0 → 两个空圈。
    usedStorageBytes: Number(u.usedStorage ?? 0) || 0,
    usedDownloadBytes: Number(u.usedDownload ?? 0) || 0,
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