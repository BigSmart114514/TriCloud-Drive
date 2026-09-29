<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import FileBrowser from '~/components/FileBrowser.vue'
import ManageUserList, { type UserSummary } from '~/components/ManageUserList.vue'
import { FolderOpenIcon, Bars3Icon, HomeIcon, ShieldExclamationIcon } from '@heroicons/vue/24/outline'

definePageMeta({ title: '管理员 - 文件总览', layout: false })

const { isAdmin, fetchUser } = useAuth()
await fetchUser()

// 非管理员直接跳回首页。真正的拦截在 auth.global.ts（SSR 阶段就拦），
// 这里只是客户端兜底 + 页面内那条「您没有管理员权限」的提示。
if (!isAdmin.value && process.client) navigateTo('/')

const users = ref<UserSummary[]>([])
const loadingUsers = ref(false)
const userSearch = ref('')
const selectedUserId = ref<number | null>(null)
const drawerOpen = ref(false)

const selectedUser = computed(
  () => users.value.find((u) => u.id === selectedUserId.value) || null
)

async function fetchUsers() {
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
  } finally {
    loadingUsers.value = false
  }
}

function selectUser(u: UserSummary) {
  selectedUserId.value = u.id
  drawerOpen.value = false
}

// 搜索词变化即查询，去抖避免逐字符打接口；回车可立即查
let timer: ReturnType<typeof setTimeout> | undefined
watch(userSearch, () => {
  clearTimeout(timer)
  timer = setTimeout(fetchUsers, 250)
})
onBeforeUnmount(() => clearTimeout(timer))

await fetchUsers()
</script>

<template>
  <!-- 整页铺满：上至 NavBar，下至屏幕底部；内容区不产生页面级滚动 -->
  <div class="flex h-[100dvh] flex-col overflow-hidden bg-gray-50">
    <AppNavbar fluid>
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

    <div class="flex min-h-0 flex-1">
      <SidePanelLayout v-model:open="drawerOpen" aria-label="用户列表">
        <template #sidebar>
          <ManageUserList
            v-model="userSearch"
            :users="users"
            :selected-id="selectedUserId"
            :loading="loadingUsers"
            @select="selectUser"
            @search="fetchUsers"
            @refresh="fetchUsers"
          />
        </template>

        <template #toolbar>
          <div class="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
            <!-- 移动端：抽屉开关 -->
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
              <h1 class="truncate text-base font-semibold text-gray-900">文件管理</h1>
              <p class="truncate text-xs text-gray-500">
                <template v-if="selectedUser">
                  {{ selectedUser.username || selectedUser.email }} · ID {{ selectedUser.id }}
                </template>
                <template v-else>未选择用户</template>
              </p>
            </div>

            <p class="hidden shrink-0 text-xs text-gray-400 xl:block">
              完整权限：上传 / 下载 / 重命名 / 删除 / 新建 / 剪贴 / 复制 / 粘贴
            </p>
          </div>
        </template>

        <div class="h-full bg-white">
          <div
            v-if="!isAdmin"
            class="m-4 flex items-center gap-2 rounded-lg bg-red-50 p-4 text-sm text-red-700"
          >
            <ShieldExclamationIcon class="h-5 w-5 shrink-0" />
            您没有管理员权限，无法访问此页面。
          </div>

          <div
            v-else-if="!selectedUser"
            class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <FolderOpenIcon class="h-12 w-12 text-gray-300" />
            <p class="text-sm text-gray-500">
              <span class="hidden lg:inline">从左侧选择一个用户</span>
              <span class="lg:hidden">点击左上角按钮打开用户列表</span>
              ，以浏览并管理其文件。
            </p>
          </div>

          <FileBrowser
            v-else
            :key="selectedUser.id"
            fill
            :target-user-id="selectedUser.id"
            :use-admin="true"
            :title="`用户：${selectedUser.username || selectedUser.email}（ID: ${selectedUser.id}）`"
          />
        </div>
      </SidePanelLayout>
    </div>
  </div>
</template>
