<template>
  <Teleport to="body">
    <Transition name="share-modal">
      <div v-if="open" class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
        <div class="absolute inset-0 bg-gray-900/40" aria-hidden="true" @click="close" />

        <div
          class="ui-glass relative flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="`分享：${name}`"
        >
          <!-- 头部 -->
          <div class="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <ShareIcon class="h-4 w-4 shrink-0 text-gray-500" />
                分享
                <span class="truncate font-normal text-gray-500">{{ name }}</span>
              </h2>
              <p class="mt-0.5 text-xs text-gray-500">
                <component :is="isFolder ? FolderIcon : DocumentIcon" class="mr-0.5 inline h-3 w-3 align-[-2px]" />
                {{ isFolder ? '文件夹' : '文件' }}
                <span v-if="ownerLabel"> · 属主 {{ ownerLabel }}</span>
              </p>
            </div>
            <button
              type="button"
              class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              aria-label="关闭"
              @click="close"
            >
              <XMarkIcon class="h-5 w-5" />
            </button>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            <!-- 分享方式：三态 -->
            <fieldset>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="m in MODE_OPTIONS"
                  :key="m.value"
                  type="button"
                  class="rounded-lg border px-2 py-2.5 text-center text-sm font-medium transition-colors"
                  :class="mode === m.value
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300 hover:bg-gray-50'"
                  :aria-pressed="mode === m.value"
                  :disabled="busy"
                  @click="applyMode(m.value)"
                >
                  {{ m.label }}
                </button>
              </div>
            </fieldset>

            <!-- 公开 -->
            <div class="mt-4 flex items-start gap-3 rounded-lg border border-gray-200 p-3">
              <GlobeAltIcon class="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
              <div class="min-w-0 flex-1">
                <label class="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-900">
                  <input
                    type="checkbox"
                    class="h-4 w-4 rounded border-gray-300 text-indigo-600"
                    :checked="isPublic"
                    :disabled="busy || mode === SHARE_NONE"
                    @change="applyPublic(($event.target as HTMLInputElement).checked)"
                  />
                  公开（免登录只读）
                </label>
                <p v-if="mode === SHARE_NONE" class="mt-1 text-[11px] leading-relaxed text-amber-600">
                  当前为「不分享」，公开不可用。
                </p>
              </div>
            </div>

            <!-- 授权人员 -->
            <div class="mt-5">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-xs font-medium text-gray-500">
                  已授权人员
                  <span v-if="grants.length" class="text-gray-400">({{ grants.length }})</span>
                </h3>
                <span v-if="mode === SHARE_NONE" class="text-[11px] text-amber-600">不分享状态下名单不生效</span>
              </div>

              <p v-if="loading" class="py-4 text-center text-xs text-gray-400">加载中…</p>
              <p v-else-if="!grants.length" class="rounded-lg bg-gray-50 py-4 text-center text-xs text-gray-400">
                还没有授权给任何人
              </p>

              <ul v-else class="space-y-1.5">
                <li
                  v-for="g in grants"
                  :key="g.userId"
                  class="flex items-center gap-2.5 rounded-lg border border-gray-100 px-2.5 py-2"
                >
                  <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-400 to-slate-500 text-xs font-semibold text-white"
                  >
                    {{ (g.user?.username || g.user?.email || 'U').slice(0, 1).toUpperCase() }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-gray-900">{{ g.user?.username || '未知用户' }}</span>
                    <span class="block truncate text-[11px] text-gray-500">{{ g.user?.email || '—' }}</span>
                  </span>
                  <select
                    class="shrink-0 rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-700 focus:border-indigo-400 focus:outline-none"
                    :value="g.permission"
                    :disabled="busy"
                    :aria-label="`修改 ${g.user?.username} 的权限`"
                    @change="changePermission(g.userId, ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="p in PERM_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
                  </select>
                  <button
                    type="button"
                    class="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                    :disabled="busy"
                    :aria-label="`移除 ${g.user?.username}`"
                    title="移除"
                    @click="removeGrant(g.userId)"
                  >
                    <XMarkIcon class="h-4 w-4" />
                  </button>
                </li>
              </ul>
            </div>

            <!-- 添加人员 -->
            <div class="mt-5 border-t border-gray-100 pt-4">
              <h3 class="mb-2 text-xs font-medium text-gray-500">添加人员</h3>
              <div class="relative">
                <MagnifyingGlassIcon class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  v-model="keyword"
                  type="search"
                  placeholder="输入用户名或邮箱搜索"
                  aria-label="搜索用户"
                  class="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-sm placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  @input="searchCandidates"
                />
              </div>

              <ul v-if="candidates.length" class="mt-2 max-h-52 space-y-1 overflow-y-auto">
                <li
                  v-for="c in candidates"
                  :key="c.id"
                  class="flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-gray-50"
                >
                  <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] font-semibold text-gray-600">
                    {{ (c.username || c.email || 'U').slice(0, 1).toUpperCase() }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-gray-900">{{ c.username }}</span>
                    <span class="block truncate text-[11px] text-gray-500">{{ c.email || '—' }}</span>
                  </span>
                  <button
                    type="button"
                    class="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                    :disabled="busy"
                    @click="addGrant(c)"
                  >
                    添加
                  </button>
                </li>
              </ul>
              <p v-else-if="searched && !searching" class="mt-2 text-center text-xs text-gray-400">
                没有匹配的用户
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  DocumentIcon,
  FolderIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  ShareIcon,
  XMarkIcon
} from '@heroicons/vue/24/outline'
import { ShareService } from '~/services/share.service'
import type { ShareCandidate, ShareGrant } from '~/services/share.service'
import { notify } from '~/utils/notify'
import {
  PERM_ALL,
  PERM_READ,
  PERM_WRITE,
  SHARE_INHERIT,
  SHARE_NONE,
  SHARE_SHARED
} from '~~/types/share'

const props = defineProps<{
  open: boolean
  targetType: 'file' | 'folder'
  targetId: number | null
  name?: string
  ownerLabel?: string
}>()

const emit = defineEmits<{ close: []; changed: [] }>()

const isFolder = computed(() => props.targetType === 'folder')

const MODE_OPTIONS = [
  { value: SHARE_NONE, label: '不分享' },
  { value: SHARE_SHARED, label: '分享' },
  { value: SHARE_INHERIT, label: '继承' }
]

const PERM_OPTIONS = [
  { value: PERM_READ, label: '只读' },
  { value: PERM_READ | PERM_WRITE, label: '读写' },
  { value: PERM_ALL, label: '读写删' }
]

const mode = ref<number>(SHARE_INHERIT)
const isPublic = ref(false)
const grants = ref<ShareGrant[]>([])
const loading = ref(false)
const busy = ref(false)

const keyword = ref('')
const candidates = ref<ShareCandidate[]>([])
const searching = ref(false)
const searched = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => [props.open, props.targetId, props.targetType] as const,
  ([open]) => {
    if (open) load()
    else reset()
  }
)

function reset() {
  grants.value = []
  candidates.value = []
  keyword.value = ''
  searched.value = false
  loading.value = false
  busy.value = false
}

async function load() {
  if (!props.targetId) return
  loading.value = true
  try {
    const res = await ShareService.list({ targetType: props.targetType, targetId: props.targetId })
    mode.value = res.mode
    isPublic.value = res.IsPublic
    grants.value = res.grants ?? []
  } catch (e: any) {
    notify(e?.data?.statusMessage || '加载分享信息失败', 'error')
  } finally {
    loading.value = false
  }
}

function close() {
  emit('close')
}

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<T | null> {
  if (busy.value) return null
  busy.value = true
  try {
    return await fn()
  } catch (e: any) {
    notify(e?.data?.statusMessage || e?.message || fallback, 'error')
    return null
  } finally {
    busy.value = false
  }
}

async function applyMode(value: number) {
  if (value === mode.value) return
  const prev = mode.value
  mode.value = value
  const res = await run(
    () => ShareService.setState({ targetType: props.targetType, targetId: props.targetId! }, { mode: value as any }),
    '设置分享方式失败'
  )
  if (res) {
    isPublic.value = res.IsPublic
    notify(res.message, 'success')
    emit('changed')
  } else {
    mode.value = prev
  }
}

async function applyPublic(next: boolean) {
  const prev = isPublic.value
  isPublic.value = next
  const res = await run(
    () => ShareService.setState({ targetType: props.targetType, targetId: props.targetId! }, { isPublic: next }),
    '设置公开失败'
  )
  if (res) {
    isPublic.value = res.IsPublic
    mode.value = res.mode
    notify(res.message, 'success')
    emit('changed')
  } else {
    isPublic.value = prev
  }
}

/**
 * 提交整份名单。名单是覆盖语义：传什么就是最终结果。
 * 所以「改某人权限」「加人」「移人」都只是先在本地算出新的名单再重发，
 * 服务端自己算出增删改（server/utils/share.ts 的 replaceAccess）。
 */
async function submitGrants(next: ShareGrant[], okMessage: string) {
  const snapshot = grants.value
  grants.value = next
  const res = await run(
    () => ShareService.setState(
      { targetType: props.targetType, targetId: props.targetId! },
      { grants: next.map((g) => ({ userId: g.userId, permission: g.permission })) }
    ),
    '保存授权名单失败'
  )
  if (res) {
    // 服务端回传的是权威值（标签、用户名可能已变），用它覆盖本地
    if (Array.isArray(res.grants)) grants.value = res.grants
    notify(res.message || okMessage, 'success')
    emit('changed')
    return true
  }
  grants.value = snapshot
  return false
}

async function changePermission(userId: number, value: string) {
  const permission = Number(value)
  const next = grants.value.map((g) => (g.userId === userId ? { ...g, permission } : g))
  await submitGrants(next, '权限已更新')
}

async function addGrant(c: ShareCandidate) {
  const permission = PERM_READ | PERM_WRITE
  const next = [...grants.value, { userId: c.id, permission, user: { username: c.username, email: c.email } }]
  if (await submitGrants(next, `已授权给 ${c.username}`)) {
    candidates.value = candidates.value.filter((x) => x.id !== c.id)
  }
}

async function removeGrant(userId: number) {
  const next = grants.value.filter((g) => g.userId !== userId)
  await submitGrants(next, '已移除授权')
}

function searchCandidates() {
  clearTimeout(searchTimer)
  const q = keyword.value.trim()
  if (!q) {
    candidates.value = []
    searched.value = false
    return
  }
  searching.value = true
  searchTimer = setTimeout(async () => {
    try {
      const exclude = grants.value.map((g) => g.userId)
      const res = await ShareService.candidates(q, exclude)
      candidates.value = res.candidates ?? []
    } catch {
      candidates.value = []
    } finally {
      searching.value = false
      searched.value = true
    }
  }, 250)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) close()
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    clearTimeout(searchTimer)
  })
}
</script>

<style scoped>
.share-modal-enter-active,
.share-modal-leave-active {
  transition: opacity 0.18s ease;
}
.share-modal-enter-active > div:last-child,
.share-modal-leave-active > div:last-child {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.share-modal-enter-from,
.share-modal-leave-to {
  opacity: 0;
}
.share-modal-enter-from > div:last-child,
.share-modal-leave-to > div:last-child {
  transform: translateY(16px);
}
@media (min-width: 640px) {
  .share-modal-enter-from > div:last-child,
  .share-modal-leave-to > div:last-child {
    transform: scale(0.97);
  }
}
</style>
