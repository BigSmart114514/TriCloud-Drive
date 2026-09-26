<!-- components/AppNavbar.vue -->
<template>
  <nav data-liquid class="bg-white shadow">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between h-16">
        <div class="flex items-center">
          <h1 class="text-xl font-semibold text-gray-900">
            TriCloud Drive
          </h1>
        </div>

        <div class="flex items-center gap-2 sm:gap-4">
          <div v-if="isLoggedIn" class="flex items-center gap-2 sm:gap-4">
            <span class="text-gray-700">
              欢迎，{{ user?.username }}
            </span>

            <!-- 右侧额外内容（修改密码） -->
            <slot name="extra" />

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
import { ArrowRightOnRectangleIcon } from '@heroicons/vue/24/outline'
import UiSettingsMenu from '~/components/UiSettingsMenu.vue'
const { user, isLoggedIn, logout } = useAuth()
const handleLogout = async () => { await logout() }
</script>