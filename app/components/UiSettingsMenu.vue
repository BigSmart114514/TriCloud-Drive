<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      class="flex items-center rounded-md p-2 text-gray-700 transition-colors hover:text-gray-900"
      :aria-expanded="open"
      aria-haspopup="true"
      aria-label="设置"
      title="设置"
      @click="open = !open"
    >
      <Cog6ToothIcon class="h-5 w-5" />
    </button>

    <transition name="settings-menu">
      <div
        v-if="open"
        class="ui-glass absolute right-0 mt-2 w-64 z-30 bg-white border border-gray-200 rounded-lg shadow-lg p-3"
        data-liquid
      >
        <label class="flex cursor-pointer items-start gap-3">
          <input
            v-model="experimentalUi"
            type="checkbox"
            class="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-indigo-600"
          />
          <span class="min-w-0">
            <span class="block text-sm font-medium text-gray-900">实验性 UI</span>
            <span class="mt-0.5 block text-xs text-gray-500">液态玻璃风格，仅保存在本地浏览器</span>
          </span>
        </label>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Cog6ToothIcon } from '@heroicons/vue/24/outline'
import { useUiPreferences } from '~/composables/useUiPreferences'

const { experimentalUi } = useUiPreferences()
const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const route = useRoute()

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
