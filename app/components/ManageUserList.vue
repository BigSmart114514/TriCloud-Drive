<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 搜索 -->
    <div class="border-b border-gray-100 p-3">
      <div class="relative">
        <MagnifyingGlassIcon
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
        />
        <input
          v-model="keyword"
          type="search"
          placeholder="按用户名搜索"
          aria-label="搜索用户名"
          class="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-9 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          @keyup.enter="emit('search', keyword)"
        />
        <button
          v-if="keyword"
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="清除搜索"
          @click="keyword = ''"
        >
          <XMarkIcon class="h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- 计数 -->
    <div class="flex items-center justify-between px-4 py-2 text-xs font-medium text-gray-500">
      <span class="flex items-center gap-1.5">
        <UserGroupIcon class="h-4 w-4" />
        {{ loading ? '加载中…' : `${users.length} 位用户` }}
      </span>
      <button
        v-if="loading"
        type="button"
        class="flex items-center gap-1 rounded px-1.5 py-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        aria-label="刷新"
        @click="emit('refresh')"
      >
        <ArrowPathIcon class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
        刷新
      </button>
    </div>

    <!-- 列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
      <p v-if="!loading && users.length === 0" class="px-3 py-10 text-center text-sm text-gray-400">
        没有匹配的用户
      </p>

      <ul v-else class="space-y-1">
        <li v-for="u in users" :key="u.id">
          <button
            type="button"
            class="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-gray-100"
            :class="u.id === selectedId ? 'bg-indigo-50 ring-1 ring-indigo-200' : ''"
            :aria-current="u.id === selectedId ? 'true' : undefined"
            @click="emit('select', u)"
          >
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
              :class="u.id === selectedId ? 'bg-indigo-600' : 'bg-gradient-to-br from-slate-400 to-slate-500'"
            >
              {{ initial(u) }}
            </span>

            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-sm font-medium text-gray-900">{{ u.self ? '我的文件' : (u.username || u.email || '未命名') }}</span>
                <ShieldCheckIcon v-if="u.IsSuperAdmin" class="h-4 w-4 shrink-0 text-purple-500" title="超级管理员" />
                <StarIcon v-else-if="u.IsAdmin" class="h-4 w-4 shrink-0 text-amber-500" title="管理员" />
              </span>
              <span v-if="u.self" class="mt-0.5 block truncate text-xs text-gray-500">
                全部文件 · 上传 · 新建
              </span>
              <span v-else class="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                <span class="truncate">{{ u.email || '—' }}</span>
                <span class="shrink-0 text-gray-300">·</span>
                <span class="shrink-0 tabular-nums">ID {{ u.id }}</span>
              </span>
            </span>

            <ChevronRightIcon
              class="h-4 w-4 shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5"
              :class="u.id === selectedId ? 'text-indigo-500' : ''"
            />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script lang="ts">
export interface UserSummary {
  id: number
  email?: string
  username?: string
  IsAdmin?: boolean
  IsSuperAdmin?: boolean
  created_at?: string
  /** 固定首行「我的文件」：点它等于取消选中，回到自己的目录 */
  self?: boolean
}
</script>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  ArrowPathIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  StarIcon,
  UserGroupIcon,
  XMarkIcon
} from '@heroicons/vue/24/outline'

const props = defineProps<{
  users: UserSummary[]
  selectedId: number | null
  loading?: boolean
  modelValue?: string
}>()

const emit = defineEmits<{
  select: [user: UserSummary]
  search: [keyword: string]
  refresh: []
  'update:modelValue': [value: string]
}>()

const keyword = ref(props.modelValue ?? '')

// 输入同步给父级（父级做去抖查询），父级回填时也要同步回来
watch(keyword, (v) => emit('update:modelValue', v))
watch(() => props.modelValue, (v) => {
  const next = v ?? ''
  if (next !== keyword.value) keyword.value = next
})

function initial(u: UserSummary) {
  return (u.username || u.email || 'U').slice(0, 1).toUpperCase()
}
</script>
