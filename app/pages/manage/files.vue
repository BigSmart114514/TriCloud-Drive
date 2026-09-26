<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuth } from '~/composables/useAuth'
import CloudFileBrowser from '~/components/CloudFileBrowser.vue'

definePageMeta({ title: '管理员 - 文件总览' })

interface UserSummary {
  id: number
  email?: string
  username?: string
  IsAdmin?: boolean
  IsSuperAdmin?: boolean
  created_at?: string
}

const { user, fetchUser } = useAuth()
await fetchUser()

const isAdmin = computed(() => {
  const u = user.value as any
  return !!(u && (u.IsSuperAdmin || u.IsAdmin || u.isSuperAdmin || u.isAdmin))
})

// 非管理员直接跳回首页
if (!isAdmin.value && process.client) navigateTo('/')

/* 左侧用户列表 */
const users = ref<UserSummary[]>([])
const loadingUsers = ref(false)
const userSearch = ref('')

async function fetchUsers() {
  try {
    loadingUsers.value = true
    const headers = process.server ? useRequestHeaders(['cookie']) : undefined
    const res = await $fetch<{ users: UserSummary[]; totalCount: number }>('/api/manage/listUsers', {
      params: userSearch.value ? { username: userSearch.value } : undefined,
      headers,
      credentials: 'include'
    })
    users.value = res.users ?? []
  } finally {
    loadingUsers.value = false
  }
}

const selectedUserId = ref<number | null>(null)
const selectedUser = computed(() => users.value.find(u => u.id === selectedUserId.value) || null)

function selectUser(u: UserSummary) {
  if (selectedUserId.value === u.id) return
  selectedUserId.value = u.id
}

await fetchUsers()
// 如需载入后自动选中第一个用户：
// if (!selectedUserId.value && users.value.length > 0) selectUser(users.value[0])
</script>

<template>
  <AppNavbar>
    <template #extra>
      <NuxtLink
        to="/"
        class="text-gray-700 hover:text-gray-900 px-3 py-2 rounded-md text-sm font-medium"
      >
        返回首页
      </NuxtLink>
    </template>
  </AppNavbar>

  <div class="p-6">
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-xl font-semibold">文件管理（管理员）</h1>
      <div class="text-xs text-gray-500">完整权限（上传/下载/重命名/删除/新建/剪贴/复制/粘贴）</div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
      <!-- 左侧：用户列表 -->
      <aside class="md:col-span-1">
        <div class="bg-white rounded-lg shadow p-4">
          <div class="flex gap-2 mb-3">
            <input
              v-model="userSearch"
              placeholder="按用户名搜索"
              class="flex-1 px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              class="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              :disabled="loadingUsers"
              @click="fetchUsers"
            >
              搜索
            </button>
          </div>

          <div class="text-sm text-gray-500 mb-2">用户列表（{{ users.length }}）</div>

          <div v-if="loadingUsers" class="text-sm text-gray-500">加载用户...</div>
          <ul v-else class="divide-y divide-gray-100 max-h-[70vh] overflow-auto">
            <li
              v-for="u in users"
              :key="u.id"
              @click="selectUser(u)"
              class="p-3 cursor-pointer rounded-md hover:bg-gray-50 flex items-center justify-between"
              :class="{ 'bg-indigo-50 ring-1 ring-indigo-200': u.id===selectedUserId }"
            >
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-semibold">
                  {{ (u.username || u.email || 'U').slice(0,1).toUpperCase() }}
                </div>
                <div>
                  <div class="text-sm font-medium text-gray-900">{{ u.username || u.email }}</div>
                  <div class="text-xs text-gray-500">ID: {{ u.id }}</div>
                </div>
              </div>
              <div class="flex items-center gap-1">
                <span v-if="u.IsSuperAdmin" class="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">超管</span>
                <span v-else-if="u.IsAdmin" class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">管理员</span>
              </div>
            </li>
          </ul>
        </div>
      </aside>

      <!-- 右侧：文件浏览 -->
      <main class="md:col-span-3">
        <div class="bg-white rounded-lg shadow p-6 min-h-[70vh]">
          <div v-if="!isAdmin" class="rounded-md bg-red-50 text-red-700 text-sm p-3">
            您没有管理员权限，无法访问此页面。
          </div>

          <div v-else-if="!selectedUser" class="text-center py-16 text-sm text-gray-500">
            从左侧选择一个用户以浏览并管理其文件。
          </div>

          <div v-else>
            <CloudFileBrowser
              :key="selectedUserId"
              :target-user-id="selectedUserId!"
              :title="`用户：${selectedUser.username || selectedUser.email}（ID: ${selectedUser.id}）`"
            />
          </div>
        </div>
      </main>
    </div>
  </div>
</template>