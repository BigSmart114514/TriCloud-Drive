<!-- pages/index.vue -->
<template>
  <!--
    已登录：整页铺满 + 左侧用户栏。
    侧栏是普通功能，数据源 /api/share/people（不是 /api/manage）：只列
    「对我分享的」+「有公开分享的」，管理员和普通用户拿到同一份数据。
    选中某人后不传 useAdmin —— 那是分享权限视角，管理员在首页拿不到提权。
  -->
  <div v-if="isLoggedIn" class="flex h-[100dvh] flex-col overflow-hidden bg-gray-50">
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
      <SidePanelLayout v-model:open="drawerOpen" aria-label="分享给我的人">
        <template #sidebar>
          <ManageUserList
            v-model="userSearch"
            :users="[selfEntry, ...people] as any"
            :selected-id="selectedUserId ?? myId"
            :loading="loadingPeople"
            @select="onSelectPerson"
            @search="loadPeople"
            @refresh="loadPeople"
          />
        </template>

        <template #toolbar>
          <div class="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
            <button
              type="button"
              class="-ml-1 rounded-md p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 lg:hidden"
              aria-label="打开用户列表"
              title="分享给我的人"
              @click="drawerOpen = true"
            >
              <Bars3Icon class="h-5 w-5" />
            </button>

            <div class="min-w-0 flex-1">
              <h1 class="truncate text-base font-semibold text-gray-900">
                {{ selected ? `${selected.username || selected.email} 的分享内容` : '我的文件' }}
              </h1>
              <p v-if="selected" class="truncate text-xs text-gray-500">
                {{ relationLabel(selected) }}
              </p>
            </div>
          </div>
        </template>

        <div class="h-full bg-white">
          <FileBrowser
            :key="selected ? `shared-${selected.id}` : 'own'"
            :variant="selected ? 'shared' : 'own'"
            :target-user-id="selected?.id ?? null"
            fill
            ref="fileListRef"
            @folder-change="onFolderChange"
            @location-change="onLocationChange"
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
        <FileBrowser
          ref="fileListRef"
          @folder-change="onFolderChange"
          @location-change="onLocationChange"
        />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { KeyIcon, Bars3Icon } from '@heroicons/vue/24/outline'
import FileBrowser from '~/components/FileBrowser.vue'
import SidePanelLayout from '~/components/SidePanelLayout.vue'
import ManageUserList from '~/components/ManageUserList.vue'
import { useAuth } from '~/composables/useAuth'

const { user, isLoggedIn } = useAuth()
const fileListRef = ref()
const currentFolderId = ref<number | null>(null)

const onFolderChange = (id: number | null) => {
  currentFolderId.value = id
}

// 标签页标题跟着「当前打开的东西」走：预览文件时是文件名，进目录是目录名。
const pageTitle = ref('我的文件')
useHead({ title: pageTitle })

const onLocationChange = (name: string) => {
  pageTitle.value = name
}

type Person = {
  id: number
  username?: string | null
  email?: string | null
  self?: boolean
  relation?: 'granted' | 'public' | 'both' | null
  maxPermission?: number
}

/**
 * 侧栏 = 「有内容是我能看的」的人，数据源 /api/share/people。
 * 普通功能：不判断 isAdmin，管理员和普通用户拿到同一份数据；
 * 选中某人后 FileBrowser 也不传 useAdmin，服务端按分享权限判。
 */
const people = ref<Person[]>([])
const loadingPeople = ref(false)
const userSearch = ref('')
/** null = 我的文件 */
const selectedUserId = ref<number | null>(null)
const drawerOpen = ref(false)

const selected = computed(() => people.value.find((p) => p.id === selectedUserId.value) || null)
const myId = computed(() => {
  const u = user.value as any
  return u ? Number(u.id) : null
})
// 侧栏首行固定是「我的文件」。接口已排除自己，这里再显式排一个，
// 语义比「在列表里找自己」清楚。
const selfEntry = computed<Person>(() => ({
  id: myId.value ?? 0,
  username: (user.value as any)?.username ?? null,
  email: (user.value as any)?.email ?? null,
  self: true
}))

function relationLabel(p: Person) {
  if (p.relation === 'granted') return '授权给我'
  if (p.relation === 'public') return '公开'
  if (p.relation === 'both') return '授权 + 公开'
  return ''
}

async function loadPeople() {
  try {
    loadingPeople.value = true
    const headers = process.server ? useRequestHeaders(['cookie']) : undefined
    const res = await $fetch<{ people: Person[] }>('/api/share/people', {
      headers,
      credentials: 'include'
    })
    const q = userSearch.value.trim().toLowerCase()
    const list = res.people ?? []
    people.value = q
      ? list.filter(
          (p) =>
            (p.username || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q)
        )
      : list
  } catch {
    people.value = []
  } finally {
    loadingPeople.value = false
  }
}

// 点自己（首行）等于回到我的文件
function onSelectPerson(p: { id: number }) {
  selectedUserId.value = Number(p.id) === myId.value ? null : Number(p.id)
  drawerOpen.value = false
}

watch(isLoggedIn, (ok) => {
  if (ok) loadPeople()
  else {
    people.value = []
    selectedUserId.value = null
  }
}, { immediate: true })

let timer: ReturnType<typeof setTimeout> | undefined
watch(userSearch, () => {
  clearTimeout(timer)
  timer = setTimeout(loadPeople, 250)
})
onBeforeUnmount(() => clearTimeout(timer))

definePageMeta({ layout: false })
</script>
