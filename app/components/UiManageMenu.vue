<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      class="flex items-center rounded-md p-2 text-gray-700 transition-colors hover:text-gray-900 sm:px-3 sm:py-2 sm:text-sm sm:font-medium"
      :aria-expanded="open"
      aria-haspopup="true"
      aria-label="管理后台"
      title="管理后台"
      @click="open = !open"
    >
      <ShieldExclamationIcon class="h-5 w-5 shrink-0" />
      <span class="hidden sm:inline ml-2">管理</span>
    </button>

    <transition name="settings-menu">
      <div
        v-if="open"
        class="ui-glass absolute right-0 mt-2 w-56 z-30 bg-white border border-gray-200 rounded-lg shadow-lg p-1.5"
        data-liquid
      >
        <NuxtLink
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors"
          :class="isCurrent(item.to)
            ? 'bg-indigo-50 text-indigo-700'
            : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'"
          :aria-current="isCurrent(item.to) ? 'page' : undefined"
          @click="close"
        >
          <component :is="item.icon" class="h-5 w-5 shrink-0" />
          {{ item.label }}
        </NuxtLink>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FolderIcon, ShieldExclamationIcon, UsersIcon } from '@heroicons/vue/24/outline'

/**
 * 导航栏上的管理入口。非管理员整个组件都不渲染（AppNavbar 用 v-if 控制挂载），
 * 所以这里只负责「点开 → 两个链接 → 跳转后自动收起」。
 */
const items = [
  { to: '/manage/files', label: '文件总览', icon: FolderIcon },
  { to: '/manage/user', label: '用户管理', icon: UsersIcon }
]

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const route = useRoute()

const isCurrent = (to: string) => route.path === to

const close = () => {
  open.value = false
}

const onDocumentMouseDown = (event: MouseEvent) => {
  if (!rootRef.value?.contains(event.target as Node)) close()
}

const onDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') close()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMouseDown)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})

watch(() => route.fullPath, close)
</script>

<style scoped>
.settings-menu-enter-active,
.settings-menu-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.settings-menu-enter-from,
.settings-menu-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
</style>
