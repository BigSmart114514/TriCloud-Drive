<!-- components/AppNavbar.vue -->
<template>
  <!-- border-b 是必须的：没有这条细线，导航栏会和下面的内容糊成一片 -->
  <nav data-liquid class="shrink-0 border-b border-gray-200 bg-white shadow-sm">
    <div :class="fluid ? 'w-full px-3 sm:px-4' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8'">
      <div class="flex justify-between h-16">
        <div class="flex items-center min-w-0">
          <!-- /manage 下的页面自动带「管理」徽标，不用每个页面各写一遍 -->
          <span
            v-if="isManageArea"
            class="mr-2 flex items-center gap-1.5 rounded-md bg-indigo-50 p-1.5 text-indigo-700 sm:px-2 sm:py-1 sm:text-xs sm:font-medium"
            title="管理后台"
          >
            <ShieldExclamationIcon class="h-3.5 w-3.5 shrink-0" />
            <span class="hidden sm:inline">管理</span>
          </span>
          <h1 class="truncate text-lg font-semibold text-gray-900 sm:text-xl">
            TriCloud Drive
          </h1>
        </div>

        <div class="flex shrink-0 items-center gap-1.5 sm:gap-4">
          <div v-if="isLoggedIn" class="flex items-center gap-1.5 sm:gap-4">
            <!-- 移动端空间紧张，招呼语直接省略 -->
            <span class="hidden text-gray-700 sm:inline">
              欢迎，{{ user?.username }}
            </span>

            <!--
              返回首页。**收在导航栏里而不是让各页面写在 #extra 里**：
              除了首页自己，所有页面都需要它，而 AppNavbar 没有面包屑 ——
              不给这个入口就只能按浏览器后退。四处各抄一遍的代价是文案和
              图标会各自漂移，改起来要改四个文件。
              首页自己不显示（在这里等于无处可去）。
            -->
            <NuxtLink
              v-if="!isHome"
              to="/"
              class="flex items-center rounded-md p-2 text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 sm:px-3 sm:py-2 sm:text-sm sm:font-medium"
              aria-label="返回首页"
              title="返回首页"
            >
              <HomeIcon class="h-5 w-5 shrink-0" />
              <span class="hidden sm:ml-1.5 sm:inline">返回首页</span>
            </NuxtLink>

            <!-- 右侧额外内容（修改密码等，页面自己决定） -->
            <slot name="extra" />

            <!--
              分享管理：**所有登录用户**都有，不设管理员门槛。
              放在导航栏而不是某个页面的 #extra 里，因为它要从任何页面都能直接到，
              而各页面的 #extra 只在自己那一页可见。

              移动端空间紧张，文字隐藏只留图标 —— 与「修改密码」同一套处理。
              aria-label 保证图标单独出现时仍有名字。
            -->
            <NuxtLink
              to="/shares"
              class="flex items-center rounded-md p-2 text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 sm:px-3 sm:py-2 sm:text-sm sm:font-medium"
              aria-label="分享管理"
              title="分享管理"
            >
              <ShareIcon class="h-5 w-5 shrink-0" />
              <span class="hidden sm:ml-1.5 sm:inline">分享管理</span>
            </NuxtLink>

            <!--
              子账户：与「分享管理」同样的口径 —— **所有登录用户都看得到**，
              因为谁都有可能是主账号。没开通建号能力时页面会把「添加子账户」
              换成提示，但已有的子账户照常看得见、改得了、删得掉。

              放在导航栏而不是只在 /shares 里加一块：那页管的是「分享」，
              账号的存废是另一件事，混在一起以后各自都不好维护。
            -->
            <NuxtLink
              to="/accounts"
              class="flex items-center rounded-md p-2 text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 sm:px-3 sm:py-2 sm:text-sm sm:font-medium"
              aria-label="子账户"
              title="子账户"
            >
              <UserGroupIcon class="h-5 w-5 shrink-0" />
              <span class="hidden sm:ml-1.5 sm:inline">子账户</span>
            </NuxtLink>

            <!-- 管理入口：仅管理员渲染，普通用户导航栏完全看不到 -->
            <UiManageMenu v-if="isAdmin" />

            <button
              @click="handleLogout"
              class="flex items-center bg-red-600 hover:bg-red-700 text-white rounded-md text-sm font-medium p-2 sm:px-4 sm:py-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              aria-label="退出登录"
              title="退出登录"
            >
              <ArrowRightOnRectangleIcon class="h-5 w-5" />
              <span class="hidden sm:inline ml-2">退出登录</span>
            </button>
          </div>

          <div v-else class="flex items-center gap-4">
            <NuxtLink
              to="/login"
              class="text-gray-700 hover:text-gray-900 px-3 py-2 rounded-md text-sm font-medium"
            >
              登录
            </NuxtLink>
            <NuxtLink
              to="/register"
              class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-sm font-medium"
            >
              注册
            </NuxtLink>
          </div>

          <UiSettingsMenu />
        </div>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  ArrowRightOnRectangleIcon,
  HomeIcon,
  ShareIcon,
  ShieldExclamationIcon,
  UserGroupIcon
} from '@heroicons/vue/24/outline'
import UiManageMenu from '~/components/UiManageMenu.vue'
import UiSettingsMenu from '~/components/UiSettingsMenu.vue'

const props = withDefaults(defineProps<{ fluid?: boolean }>(), { fluid: false })
const fluid = computed(() => props.fluid)

const route = useRoute()
const isManageArea = computed(() => route.path === '/manage' || route.path.startsWith('/manage/'))

/** 首页自己不需要「返回首页」。带 query 的（/?at=127）也是首页，不显示 */
const isHome = computed(() => route.path === '/')

const { user, isLoggedIn, isAdmin, logout } = useAuth()
const handleLogout = async () => { await logout() }
</script>