<script setup lang="ts">

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import FileBrowser from '~/components/FileBrowser.vue'
import ManageUserList, { type UserSummary } from '~/components/ManageUserList.vue'
import SearchDialog from '~/components/SearchDialog.vue'
import type { SearchFileHit, SearchPathNode } from '~/services/search.service'
import { notifyError } from '~/utils/notify'
import { FolderOpenIcon, Bars3Icon, ShieldExclamationIcon, MagnifyingGlassIcon } from '@heroicons/vue/24/outline'

useHead({ title: '文件总览' })

// 标题用下面的 useHead。definePageMeta({ title }) 在 Nuxt 4 已经不写 <title> 了，别留着误导
definePageMeta({ layout: false })

const { user: authUser, isAdmin, fetchUser } = useAuth()
await fetchUser()

// 非管理员直接跳回首页。真正的拦截在 auth.global.ts（SSR 阶段就拦），
// 这里只是客户端兜底 + 页面内那条「您没有管理员权限」的提示。
if (!isAdmin.value && process.client) navigateTo('/')

const users = ref<UserSummary[]>([])

// 这一处原本**没有** catch —— 失败就让异常往上抛（页面整体报错）。
// 所以既不给 errorMessage 也不给 onError，与原行为一致。
const { loading: loadingUsers, reload: fetchUsers } = useAsyncResource(async () => {
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
})
const userSearch = ref('')
const selectedUserId = ref<number | null>(null)
const drawerOpen = ref(false)

const selectedUser = computed(
  () => users.value.find((u) => u.id === selectedUserId.value) || null
)

/**
 * 服务端 getMeAndTarget 已经拦了「非超管不得进入超管数据」（403）。
 * 这里只是把不可选的人**显示出来但点不动**，而不是选中后弹一个 403 ——
 * 沿用 manage/user.vue 里 disableDeleteFor 的做法：看得见，但操作不给。
 *
 * 判定必须和服务端同规则，只禁**超管**（getMeAndTarget 里就是这一条）：
 * 千万别用 useAuth 的 isAdmin 来「有权限就全放行」—— 那个是
 * IsAdmin || IsSuperAdmin，普通管理员也是 true，那样等于这里什么都不拦。
 * 要的是「我是不是超管」，所以自己算 isSuper。
 */
const isSuper = computed(() => !!authUser.value?.IsSuperAdmin)

function isSelectable(u: UserSummary) {
  if (isSuper.value) return true
  // 自己的文件永远能看（服务端 guard 只查目标是不是超管，自己不是）
  if (u.id === authUser.value?.id) return true
  return !u.IsSuperAdmin
}

function selectUser(u: UserSummary) {
  if (!isSelectable(u)) {
    notifyError(u.IsSuperAdmin ? '普通管理员不能访问超级管理员的文件' : '普通管理员不能访问管理员的文件')
    return
  }
  selectedUserId.value = u.id
  drawerOpen.value = false
}

/* ---------------- 全站搜索 ---------------- */

const searchOpen = ref(false)

/**
 * 搜索结果的落点在**别的**属主树里时的待执行跳转。
 *
 * 超管的「全站搜索」可能命中任何用户的文件，而 FileBrowser 只看当前侧栏
 * 选中的那个人。所以先把指令存这里，再切 `selectedUserId` —— 组件会因
 * `:key` 重建，重建时通过 `:initial-jump` 把指令带进去。
 * 组件消费完会 emit `jump-consumed`，那时清空，避免下次重建重复空降。
 */
const pendingJump = ref<{ ownerId: number; path: SearchPathNode[]; file?: SearchFileHit } | null>(null)

async function onSearchPick(payload: { ownerId: number; path: SearchPathNode[]; file?: SearchFileHit }) {
  searchOpen.value = false
  const owner = Number(payload.ownerId)

  // 同一棵树，而且那棵树正开着（selectedUser 有值 = FileBrowser 已渲染）：
  // 指令直接交给它，watcher 会接住（组件不重建，走「挂载后到达」那一条路）。
  // 判 selectedUser 而不是 selectedUserId —— 侧栏关键词可能把已选中的人过滤掉，
  // 那时 selectedUserId 还在，但组件已经被卸载了。
  if (selectedUser.value && owner === selectedUserId.value) {
    pendingJump.value = payload
    return
  }

  // 换属主。目标可能被侧栏的关键词过滤掉了 —— 那种情况下 selectedUser 为 null，
  // FileBrowser 不渲染（它挂在 selectedUser 上），跳转无处落地，先清掉过滤重拉。
  if (!users.value.some((u) => u.id === owner)) {
    userSearch.value = ''
    await fetchUsers()
    if (!users.value.some((u) => u.id === owner)) {
      notifyError('找不到这个文件所属的用户，可能账号已被删除')
      return
    }
  }
  pendingJump.value = payload
  selectedUserId.value = owner
  drawerOpen.value = false
}

// 搜索词变化即查询，去抖避免逐字符打接口；回车可立即查。
// 序号守卫由 useDebounced 白得（原先只有 setTimeout + clearTimeout，慢的旧请求
// 会覆盖新结果）。见 app/composables/useDebounced.ts。
const { schedule: scheduleUserSearch } = useDebounced<void>({
  delay: 250,
  run: () => fetchUsers()
})
watch(userSearch, () => scheduleUserSearch())

await fetchUsers()
</script>

<template>
  <!-- 整页铺满：上至 NavBar，下至屏幕底部；内容区不产生页面级滚动 -->
  <div class="flex h-[100dvh] flex-col overflow-hidden bg-gray-50">
    <AppNavbar fluid />

    <div class="flex min-h-0 flex-1">
      <SidePanelLayout v-model:open="drawerOpen" aria-label="用户列表">
        <template #sidebar>
          <ManageUserList
            v-model="userSearch"
            :users="users"
            :selected-id="selectedUserId"
            :loading="loadingUsers"
            :selectable="isSelectable"
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

            <!--
              全站搜索入口。**只给超管**：普通管理员在这里能管别人的文件，
              但「能搜到谁」是另一个问题 —— 需求是普通管理员不许跨站搜。
              服务端对 scope=site 也会自己验一次 isSuperAdmin（见
              server/api/files/search.get.ts），这里只决定要不要显示按钮。
            -->
            <button
              v-if="isSuper"
              type="button"
              class="-mr-1 shrink-0 rounded-md p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
              aria-label="搜索全站"
              title="搜索全站"
              @click="searchOpen = true"
            >
              <MagnifyingGlassIcon class="h-5 w-5" />
            </button>
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
            :target-user-label="selectedUser.username || selectedUser.email || ''"
            :title="`用户：${selectedUser.username || selectedUser.email}（ID: ${selectedUser.id}）`"
            :initial-jump="pendingJump"
            @jump-consumed="pendingJump = null"
          />
        </div>
      </SidePanelLayout>
    </div>

    <SearchDialog
      :open="searchOpen"
      scope="site"
      @close="searchOpen = false"
      @pick="onSearchPick"
    />
  </div>
</template>
