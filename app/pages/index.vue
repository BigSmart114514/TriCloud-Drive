<!-- pages/index.vue -->
<template>
  <!--
    管理员：整页铺满（h-[100dvh] + SidePanelLayout），左栏顶格、与 /manage/files 一致。
    顶部那排切换按钮挪进 toolbar，主区因此能占满整列宽度。
  -->
  <div v-if="isLoggedIn && isAdmin" class="flex h-[100dvh] flex-col overflow-hidden bg-gray-50">
    <AppNavbar fluid>
      <template #extra>
        <NuxtLink
          to="/services/change-password"
          class="text-gray-700 hover:text-gray-900 rounded-md text-sm font-medium p-2 sm:px-3 sm:py-2 flex items-center"
          aria-label="修改密码"
          title="修改密码"
        >
          <KeyIcon class="h-5 w-5" />
          <span class="hidden sm:inline ml-2">修改密码</span>
        </NuxtLink>
      </template>
    </AppNavbar>

    <div class="flex min-h-0 flex-1">
      <SidePanelLayout v-model:open="drawerOpen" aria-label="用户列表">
        <template #sidebar>
          <ManageUserList
            v-model="userSearch"
            :users="users"
            :selected-id="selectedUserId"
            :loading="loadingUsers"
            @select="onSelectUserSummary"
            @search="fetchUsers"
            @refresh="fetchUsers"
          />
        </template>

        <template #toolbar>
          <div class="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
            <button
              type="button"
              class="-ml-1 rounded-md p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 lg:hidden"
              aria-label="打开用户列表"
              title="用户列表"
              @click="drawerOpen = true"
            >
              <Bars3Icon class="h-5 w-5" />
            </button>

            <div class="min-w-0 flex-1">
              <h1 class="truncate text-base font-semibold text-gray-900">
                {{ selectedUser ? `${selectedUser.username || selectedUser.email} 的分享内容` : '我的文件' }}
              </h1>
              <p v-if="selectedUser" class="truncate text-xs text-gray-500">
                ID {{ selectedUser.id }} · 只列出被标记为分享或公开的项
              </p>
            </div>
          </div>
        </template>

        <div class="h-full bg-white">
          <SharedItemsBrowser
            v-if="selectedUser"
            :key="selectedUser.id"
            :user-id="selectedUser.id"
          />
          <CloudFileBrowser
            v-else
            fill
            ref="fileListRef"
            @folder-change="onFolderChange"
          />
        </div>
      </SidePanelLayout>
    </div>
  </div>

  <!-- 未登录 / 普通用户：与改造前完全一致 -->
  <div v-else class="min-h-screen bg-gray-50">
    <AppNavbar>
      <template #extra>
        <NuxtLink
          to="/services/change-password"
          class="text-gray-700 hover:text-gray-900 rounded-md text-sm font-medium p-2 sm:px-3 sm:py-2 flex items-center"
          aria-label="修改密码"
          title="修改密码"
        >
          <KeyIcon class="h-5 w-5" />
          <span class="hidden sm:inline ml-2">修改密码</span>
        </NuxtLink>
      </template>
    </AppNavbar>

    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <div v-if="!isLoggedIn" class="px-4 py-6 sm:px-0">
        <div class="text-center">
          <h2 class="text-3xl font-extrabold text-gray-900 sm:text-4xl">欢迎来到 TriCloud Drive</h2>
          <p class="mt-4 text-lg text-gray-600">不安全、不可靠的云存储解决方案（bushi</p>
          <div class="mt-6">
            <NuxtLink
              to="/register"
              class="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
            >
              开始使用
            </NuxtLink>
          </div>
        </div>
      </div>

      <div v-else class="px-4 py-6 sm:px-0">
        <CloudFileBrowser
          ref="fileListRef"
          @folder-change="onFolderChange"
        />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { KeyIcon, Bars3Icon } from '@heroicons/vue/24/outline'
import CloudFileBrowser from '~/components/CloudFileBrowser.vue'
import SidePanelLayout from '~/components/SidePanelLayout.vue'
import SharedItemsBrowser from '~/components/SharedItemsBrowser.vue'
import ManageUserList, { type UserSummary } from '~/components/ManageUserList.vue'
import { useAuth } from '~/composables/useAuth'

const { user, isLoggedIn, fetchUser } = useAuth()
const fileListRef = ref()
const currentFolderId = ref<number | null>(null)

const onFolderChange = (id: number | null) => {
  currentFolderId.value = id
}

const isAdmin = computed(() => {
  const u = user.value as any
  return !!(u && (u.IsSuperAdmin || u.IsAdmin || u.isSuperAdmin || u.isAdmin))
})

// 侧栏与共享清单只对管理员开放；非管理员走下面的普通分支
const users = ref<UserSummary[]>([])
const loadingUsers = ref(false)
const userSearch = ref('')
const selectedUserId = ref<number | null>(null)
const drawerOpen = ref(false)

const selectedUser = computed(
  () => users.value.find((u) => u.id === selectedUserId.value) || null
)

// 自己没有「分享给我的人」这层含义：点自己等于回到我的文件
const myId = computed(() => {
  const u = user.value as any
  return u ? Number(u.id) : null
})

async function fetchUsers() {
  if (!isAdmin.value) return
  try {
    loadingUsers.value = true
    const headers = process.server ? useRequestHeaders(['cookie']) : undefined
    const res = await $fetch<{ users: UserSummary[]; totalCount: number }>(
      '/api/manage/listUsers',
      {
        params: userSearch.value ? { username: userSearch.value } : undefined,
        headers,
        credentials: 'include'
      }
    )
    users.value = res.users ?? []
  } catch {
    users.value = []
  } finally {
    loadingUsers.value = false
  }
}

function onSelectUserSummary(u: UserSummary) {
  selectUser(Number(u.id) === myId.value ? null : u.id)
  drawerOpen.value = false
}

function selectUser(id: number | null) {
  selectedUserId.value = id
}

watch(isAdmin, (admin) => {
  if (admin) fetchUsers()
  else {
    users.value = []
    selectedUserId.value = null
  }
}, { immediate: true })

let timer: ReturnType<typeof setTimeout> | undefined
watch(userSearch, () => {
  if (!isAdmin.value) return
  clearTimeout(timer)
  timer = setTimeout(fetchUsers, 250)
})
onBeforeUnmount(() => clearTimeout(timer))

definePageMeta({ layout: false })
</script>
