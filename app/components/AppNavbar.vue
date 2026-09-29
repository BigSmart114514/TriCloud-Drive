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

            <!-- 右侧额外内容（修改密码 / 返回首页） -->
            <slot name="extra" />

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
import { ArrowRightOnRectangleIcon, ShieldExclamationIcon } from '@heroicons/vue/24/outline'
import UiManageMenu from '~/components/UiManageMenu.vue'
import UiSettingsMenu from '~/components/UiSettingsMenu.vue'

const props = withDefaults(defineProps<{ fluid?: boolean }>(), { fluid: false })
const fluid = computed(() => props.fluid)

const route = useRoute()
const isManageArea = computed(() => route.path === '/manage' || route.path.startsWith('/manage/'))

const { user, isLoggedIn, isAdmin, logout } = useAuth()
const handleLogout = async () => { await logout() }
</script>