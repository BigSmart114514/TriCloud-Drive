<template>
  <div class="flex h-full min-h-0 w-full">
    <!-- 桌面：左栏常驻 -->
    <aside
      v-if="hasSidebar"
      class="hidden shrink-0 flex-col border-r border-gray-200 bg-white lg:flex"
      :class="sidebarWidthClass"
      aria-label="侧边栏"
    >
      <div class="flex min-h-0 flex-1 flex-col">
        <slot name="sidebar" />
      </div>
    </aside>

    <!-- 右侧主区 -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <slot name="toolbar" />
      <div class="min-h-0 flex-1 overflow-hidden">
        <slot />
      </div>
    </div>

    <!-- 移动端：左栏抽屉。用 Teleport 移出页面，避免被祖先的 filter/backdrop-filter 困住 -->
    <Teleport to="body">
      <Transition name="panel-drawer">
        <div v-if="hasSidebar && open" class="fixed inset-0 z-50 lg:hidden">
          <div
            class="absolute inset-0 bg-gray-900/40"
            aria-hidden="true"
            @click="closeDrawer"
          />
          <aside
            class="ui-glass absolute inset-y-0 left-0 flex w-80 max-w-[85vw] flex-col border-r border-gray-200 bg-white shadow-2xl"
            role="dialog"
            aria-modal="true"
            :aria-label="ariaLabel"
          >
            <div class="flex items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
              <h2 class="truncate text-sm font-semibold text-gray-900">{{ ariaLabel }}</h2>
              <button
                type="button"
                class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                aria-label="关闭侧边栏"
                title="关闭"
                @click="closeDrawer"
              >
                <XMarkIcon class="h-5 w-5" />
              </button>
            </div>
            <div class="flex min-h-0 flex-1 flex-col">
              <slot name="sidebar" />
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { XMarkIcon } from '@heroicons/vue/24/outline'

const props = withDefaults(
  defineProps<{
    /** 移动端抽屉是否展开 */
    open?: boolean
    /** 无 slot 时整个左栏不渲染 */
    hasSidebar?: boolean
    ariaLabel?: string
    sidebarWidth?: 'sm' | 'md' | 'lg'
  }>(),
  {
    open: false,
    hasSidebar: true,
    ariaLabel: '侧边栏',
    sidebarWidth: 'md'
  }
)

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const route = useRoute()

function closeDrawer() {
  emit('update:open', false)
}

const sidebarWidthClass = {
  sm: 'lg:w-64',
  md: 'lg:w-72',
  lg: 'lg:w-80'
}[props.sidebarWidth]

// 路由切换后自动收起抽屉，避免遮住新页面
watch(() => route.fullPath, () => closeDrawer())

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) closeDrawer()
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
</script>

<style scoped>
.panel-drawer-enter-active,
.panel-drawer-leave-active {
  transition: opacity 0.22s ease;
}
.panel-drawer-enter-active aside,
.panel-drawer-leave-active aside {
  transition: transform 0.26s cubic-bezier(0.32, 0.72, 0, 1);
}
.panel-drawer-enter-from,
.panel-drawer-leave-to {
  opacity: 0;
}
.panel-drawer-enter-from aside,
.panel-drawer-leave-to aside {
  transform: translateX(-100%);
}
</style>
