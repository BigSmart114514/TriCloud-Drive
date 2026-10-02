<template>
  <div class="min-h-screen bg-gray-50">
    <AppNavbar />

    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
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

      <!--
        没有建号能力时：下面照常列已有子账户，只把「添加子账户」那张卡换成
        提示。不因为关掉开关就把已建的孩子变成没人管的孤儿 ——
        主账号可能只是暂时被收回了权限，孩子还得能改限额、能删。
      -->
      <div v-else class="px-4 py-6 sm:px-0">
        <!-- 顶部工具栏 -->
        <div class="mb-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <h2 class="text-2xl font-bold text-gray-900">子账户</h2>
          <div class="flex flex-wrap items-center gap-3">
            <input
              v-model="filters.username"
              @keyup.enter="fetchAccounts"
              type="text"
              placeholder="按用户名搜索"
              class="w-72 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
            />
            <button
              @click="fetchAccounts"
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
              @click="fetchAccounts"
              class="bg-white hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-md text-sm border"
              :disabled="loading"
            >
              刷新
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <!-- 添加子账户 -->
          <div class="bg-white shadow rounded-lg p-6">
            <h3 class="text-lg font-medium text-gray-900 mb-4">添加子账户</h3>

            <!-- 没开通建号能力：只换这一张卡，下面的列表照常 -->
            <div v-if="capability && !capability.canSubAccount" class="rounded-md border-l-4 border-amber-400 bg-amber-50 p-4">
              <p class="text-sm text-amber-800">
                当前账号不能创建子账户，请联系管理员开通。
              </p>
            </div>

            <form v-else-if="capability" @submit.prevent="handleCreate" class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700">邮箱</label>
                <input
                  v-model="addForm.email"
                  type="email"
                  autocomplete="off"
                  class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">用户名</label>
                <input
                  v-model="addForm.username"
                  type="text"
                  autocomplete="off"
                  class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                  placeholder="只能包含大小写字母和数字"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">初始密码</label>
                <input
                  v-model="addForm.password"
                  type="password"
                  autocomplete="new-password"
                  class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                  placeholder="至少8位，包含字母和数字"
                />
                <p class="mt-1.5 text-xs text-gray-400">
                  子账户不能自己改密码，忘了只能由你重置。
                </p>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-sm font-medium text-gray-700">存储上限</label>
                  <input
                    v-model="addForm.maxStorage"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                    placeholder="0（不限）"
                    title="支持单位：B, KB, MB, GB, TB；填 0 表示不限，实际仍受你的共享容量限制"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700">下载上限</label>
                  <input
                    v-model="addForm.maxDownload"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                    placeholder="0（不限）"
                    title="支持单位：B, KB, MB, GB, TB；填 0 表示不限，实际仍受你的共享流量限制"
                  />
                </div>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">到期时间</label>
                <input
                  v-model="addForm.expire_at"
                  type="datetime-local"
                  step="1"
                  class="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                  title="留空表示永不过期"
                />
                <p class="mt-1.5 text-xs text-gray-400">留空表示永不过期</p>
              </div>
              <div class="flex items-center gap-3">
                <button
                  type="submit"
                  class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-sm font-medium"
                  :disabled="addLoading"
                >
                  {{ addLoading ? '创建中...' : '创建子账户' }}
                </button>
                <p v-if="addMessage" class="text-sm text-green-600">{{ addMessage }}</p>
                <p v-if="addError" class="text-sm text-red-600">{{ addError }}</p>
              </div>
            </form>
          </div>

          <!-- 概览 -->
          <div class="bg-white shadow rounded-lg p-6">
            <h3 class="text-lg font-medium text-gray-900 mb-4">概览</h3>
            <dl class="space-y-3">
              <div>
                <dt class="text-sm font-medium text-gray-500">子账户数</dt>
                <dd class="text-2xl font-semibold text-gray-900">
                  {{ totalCount }}<span v-if="limitText" class="ml-1 text-sm font-normal text-gray-400">/ {{ limitText }}</span>
                </dd>
              </div>
              <div>
                <dt class="text-sm font-medium text-gray-500">共享存储</dt>
                <dd class="text-sm text-gray-900">
                  {{ formatFileSize(pool.storage.total) }}<span class="text-gray-400"> / {{ pool.storage.max > 0 ? formatFileSize(pool.storage.max) : '不限' }}</span>
                </dd>
              </div>
              <div>
                <dt class="text-sm font-medium text-gray-500">共享下载流量</dt>
                <dd class="text-sm text-gray-900">
                  {{ formatFileSize(pool.download.total) }}<span class="text-gray-400"> / {{ pool.download.max > 0 ? formatFileSize(pool.download.max) : '不限' }}</span>
                </dd>
              </div>
              <div v-if="loading" class="text-sm text-gray-500">正在加载子账户数据...</div>
              <div v-else class="text-sm text-gray-500">最近刷新：{{ lastRefreshed ? formatDateTime(lastRefreshed) : '—' }}</div>
            </dl>
          </div>
        </div>

        <!-- 列表 -->
        <div class="bg-white shadow rounded-lg overflow-hidden">
          <div class="px-6 py-4 border-b">
            <h3 class="text-lg font-medium text-gray-900">子账户列表</h3>
          </div>

          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">子账户</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">存储</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">下载流量</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">到期</th>
                  <th class="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr v-if="loading">
                  <td colspan="5" class="px-6 py-8 text-center text-sm text-gray-500">载入中...</td>
                </tr>
                <tr v-else-if="children.length === 0">
                  <td colspan="5" class="px-6 py-8 text-center text-sm text-gray-500">还没有子账户</td>
                </tr>
                <tr
                  v-for="c in children"
                  :key="c.id"
                  class="cursor-pointer transition-colors hover:bg-gray-50"
                  :class="editing?.id === c.id ? 'bg-indigo-50/60' : ''"
                  @click="openEditor(c)"
                >
                  <td class="px-6 py-3 whitespace-nowrap">
                    <span class="flex items-center gap-2 text-sm font-medium text-gray-900">
                      <span class="truncate">{{ c.username || c.email || '未命名' }}</span>
                      <span
                        v-if="c.expired"
                        class="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-700"
                        title="套餐已过期，该子账户现在不能上传、下载或复制"
                      >已过期</span>
                    </span>
                    <span v-if="c.email" class="mt-0.5 block truncate text-xs text-gray-500">{{ c.email }}</span>
                  </td>
                  <td class="px-6 py-3 whitespace-nowrap text-sm tabular-nums text-gray-700">{{ usage(c.usedStorage, c.maxStorage) }}</td>
                  <td class="px-6 py-3 whitespace-nowrap text-sm tabular-nums text-gray-700">{{ usage(c.usedDownload, c.maxDownload) }}</td>
                  <td class="px-6 py-3 whitespace-nowrap text-sm text-gray-500">{{ c.expireAt ? formatDateTime(c.expireAt) : '—' }}</td>
                  <td class="px-6 py-3 whitespace-nowrap text-right">
                    <button
                      type="button"
                      class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white hover:text-indigo-600 hover:shadow-sm"
                      :aria-label="`编辑子账户 ${c.username}`"
                      title="编辑"
                      @click.stop="openEditor(c)"
                    >
                      <PencilSquareIcon class="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <AccountEditDialog
          :open="!!editing"
          :child="editing"
          :saving="updatingId === editing?.id"
          :deleting="deletingId === editing?.id"
          :can-delete="!!editing"
          @close="closeEditor"
          @save="saveChild"
          @delete="deleteEditingChild"
          @reset-password="resetPassword(editing!)"
        />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { PencilSquareIcon } from '@heroicons/vue/24/outline'
import AppNavbar from '~/components/AppNavbar.vue'
import AccountEditDialog, { type AccountDraft } from '~/components/AccountEditDialog.vue'
import {
  AccountService,
  type SubAccount,
  type SubAccountCapability
} from '~/services/account.service'
import { formatDateTime } from '~/utils/time'
import { formatFileSize } from '~/utils/format'
import { formatBytes, parseBytes } from '~/utils/size'
import { fromDatetimeLocal } from '~/utils/datetimeLocal'
import { notify, notifyError, toMessage } from '~/utils/notify'

useHead({ title: '子账户' })

const { isLoggedIn } = useAuth()

const children = ref<SubAccount[]>([])
const totalCount = ref(0)
const loading = ref(false)
const lastRefreshed = ref<string | null>(null)

const capability = ref<SubAccountCapability | null>(null)

const pool = reactive({
  storage: { own: 0, children: 0, total: 0, max: 0 },
  download: { own: 0, children: 0, total: 0, max: 0 }
})

const filters = reactive({ username: '' })

const addForm = reactive({ email: '', username: '', password: '', maxStorage: '0', maxDownload: '0', expire_at: '' })
const addLoading = ref(false)
const addMessage = ref('')
const addError = ref('')

const editing = ref<SubAccount | null>(null)
const updatingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)

/** 「已用 / 上限」，0 = 不限 */
function usage(used: number, max: number): string {
  return `${formatFileSize(used)} / ${max > 0 ? formatFileSize(max) : '不限'}`
}

const limitText = computed(() => {
  const m = capability.value?.maxSubAccount ?? 0
  return m > 0 ? `${m}` : ''
})

const fetchAccounts = async () => {
  loading.value = true
  try {
    const res = await AccountService.list(filters.username.trim() || undefined)
    children.value = res.children
    totalCount.value = res.totalCount
    pool.storage = res.pool.storage
    pool.download = res.pool.download
    capability.value = res.capability
    lastRefreshed.value = new Date().toISOString()
  } catch (err: any) {
    notifyError(err, '加载子账户失败')
  } finally {
    loading.value = false
  }
}

const resetFilters = () => {
  filters.username = ''
  fetchAccounts()
}

/**
 * 建号。两个默认值要写清，界面上也写了：
 *   maxStorage/maxDownload = '0' = 不限（受主账号的池兜底）。
 *   expire_at = '' = 永不过期。
 * 别改成 1 —— users 表的列默认就是 1，也就是 1 字节，新建就立刻什么都传不了。
 */
const handleCreate = async () => {
  addLoading.value = true
  addMessage.value = ''
  addError.value = ''
  try {
    const res = await AccountService.create({
      email: addForm.email.trim(),
      username: addForm.username.trim(),
      password: addForm.password,
      maxStorage: parseBytes(addForm.maxStorage),
      maxDownload: parseBytes(addForm.maxDownload),
      expire_at: fromDatetimeLocal(addForm.expire_at || null)
    })
    addMessage.value = res.statusMessage || '已创建'
    addForm.email = ''
    addForm.username = ''
    addForm.password = ''
    addForm.maxStorage = '0'
    addForm.maxDownload = '0'
    addForm.expire_at = ''
    await fetchAccounts()
  } catch (err: any) {
    addError.value = toMessage(err, '创建失败')
  } finally {
    addLoading.value = false
  }
}

const openEditor = (c: SubAccount) => {
  editing.value = c
}

const closeEditor = () => {
  editing.value = null
}

const saveChild = async (draft: AccountDraft) => {
  const c = editing.value
  if (!c) return
  updatingId.value = c.id
  try {
    await AccountService.updateQuota(c.id, {
      maxStorage: parseBytes(draft.maxStorage),
      maxDownload: parseBytes(draft.maxDownload),
      expire_at: fromDatetimeLocal(draft.expire_at ?? null)
    })
    notify('已保存', 'success')
    closeEditor()
    await fetchAccounts()
  } catch (err: any) {
    notifyError(err, '保存失败')
  } finally {
    updatingId.value = null
  }
}

const deleteEditingChild = async () => {
  const c = editing.value
  if (!c) return
  deletingId.value = c.id
  try {
    const res = await AccountService.remove(c.id)
    notify(res.statusMessage || '已删除', 'success')
    closeEditor()
    await fetchAccounts()
  } catch (err: any) {
    notifyError(err, '删除失败')
  } finally {
    deletingId.value = null
  }
}

/**
 * 重置密码走 /accounts/accounts/reset-password，不走 auth/change-password
 * 的 targetUserId —— 那条路要求 isStaff（见 resolveIdentity），主账号不是管理员。
 */
const resetPassword = async (c: SubAccount) => {
  const input = window.prompt(`为子账户「${c.username}」设置新密码（至少8位，包含字母和数字）：`, '')
  if (input === null) return
  const newPassword = input.trim()
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    notify('密码不符合要求：至少8位，且需包含字母和数字', 'error')
    return
  }
  try {
    await AccountService.resetPassword(c.id, newPassword)
    notify('密码已重置', 'success')
  } catch (err: any) {
    notifyError(err, '重置密码失败')
  }
}

onMounted(fetchAccounts)
</script>