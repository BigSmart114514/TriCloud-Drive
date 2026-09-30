<template>
  <Teleport to="body">
    <Transition name="user-modal">
      <div v-if="open && draft" class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
        <div class="absolute inset-0 bg-gray-900/40" aria-hidden="true" @click="close" />

        <div
          class="relative flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="`编辑用户：${displayName}`"
          @keydown.esc="close"
        >
          <!-- 头部 -->
          <div class="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <PencilSquareIcon class="h-4 w-4 shrink-0 text-gray-500" />
                编辑用户
                <span class="truncate font-normal text-gray-500">{{ displayName }}</span>
              </h2>
              <p class="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                <span>ID {{ draft.id }}</span>
                <template v-if="draft.email">
                  <span class="text-gray-300">·</span>
                  <span class="truncate">{{ draft.email }}</span>
                </template>
                <ShieldCheckIcon v-if="draft.IsSuperAdmin" class="h-3.5 w-3.5 shrink-0 text-purple-500" title="超级管理员" />
                <StarIcon v-else-if="draft.IsAdmin" class="h-3.5 w-3.5 shrink-0 text-amber-500" title="管理员" />
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

          <!-- 内容 -->
          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
            <!-- 只读提示：普通管理员点开管理员/超管时会看到 -->
            <div
              v-if="readOnly"
              class="flex items-start gap-2 rounded-lg border-l-4 border-amber-400 bg-amber-50 px-3 py-2"
            >
              <ShieldExclamationIcon class="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p class="text-xs leading-relaxed text-amber-800">
                普通管理员不能修改管理员或超级管理员，以下内容为只读。
              </p>
            </div>

            <!-- 角色 -->
            <fieldset :disabled="readOnly">
              <legend class="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">角色</legend>
              <div class="grid grid-cols-2 gap-2">
                <label
                  class="flex cursor-pointer items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-3 py-2.5 transition-colors has-[:checked]:border-amber-300 has-[:checked]:bg-amber-50"
                  :class="readOnly ? 'cursor-not-allowed opacity-60' : 'hover:bg-gray-50'"
                >
                  <input
                    v-model="draft.IsAdmin"
                    type="checkbox"
                    :disabled="readOnly"
                    class="h-4 w-4 rounded border-gray-300 text-indigo-600"
                  />
                  <span class="flex min-w-0 items-center gap-1.5 text-sm text-gray-800">
                    <StarIcon class="h-4 w-4 shrink-0 text-amber-500" />
                    管理员
                  </span>
                </label>

                <label
                  class="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-3 py-2.5 transition-colors has-[:checked]:border-purple-300 has-[:checked]:bg-purple-50"
                  :class="canGrantSuper ? 'cursor-pointer hover:bg-gray-50' : 'cursor-not-allowed opacity-60'"
                  :title="canGrantSuper ? undefined : '只有超级管理员可以授予或取消超级管理员'"
                >
                  <input
                    v-model="draft.IsSuperAdmin"
                    type="checkbox"
                    :disabled="readOnly || !canGrantSuper"
                    class="h-4 w-4 rounded border-gray-300 text-indigo-600"
                  />
                  <span class="flex min-w-0 items-center gap-1.5 text-sm text-gray-800">
                    <ShieldCheckIcon class="h-4 w-4 shrink-0 text-purple-500" />
                    超级管理员
                  </span>
                </label>
              </div>
            </fieldset>

            <!-- 套餐过期时间 -->
            <div :class="readOnly ? 'opacity-60' : ''">
              <label class="mb-2 block text-xs font-medium uppercase tracking-wider text-gray-500">
                套餐过期时间
              </label>
              <input
                v-model="draft.expire_at"
                type="datetime-local"
                step="1"
                :disabled="readOnly"
                class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
                title="选择日期时间；清空表示不过期"
                @blur="normalizeExpire"
              />
              <p class="mt-1.5 text-xs text-gray-400">清空表示永不过期</p>
            </div>

            <!-- 容量 -->
            <div :class="readOnly ? 'opacity-60' : ''">
              <p class="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">容量</p>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="mb-1 block text-xs text-gray-500" :for="`maxStorage-${draft.id}`">限制</label>
                  <input
                    :id="`maxStorage-${draft.id}`"
                    v-model="draft.maxStorage"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    :disabled="readOnly"
                    class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
                    placeholder="如 10 GB"
                    title="支持单位：B, KB, MB, GB, TB；填 0 表示不限"
                    @blur="normalizeSize('maxStorage')"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-xs text-gray-500" :for="`usedStorage-${draft.id}`">已使用</label>
                  <input
                    :id="`usedStorage-${draft.id}`"
                    v-model="draft.usedStorage"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    :disabled="readOnly"
                    class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
                    placeholder="如 512 MB"
                    title="支持单位：B, KB, MB, GB, TB"
                    @blur="normalizeSize('usedStorage')"
                  />
                </div>
              </div>
            </div>

            <!-- 下载 -->
            <div :class="readOnly ? 'opacity-60' : ''">
              <p class="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">下载</p>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="mb-1 block text-xs text-gray-500" :for="`maxDownload-${draft.id}`">限制</label>
                  <input
                    :id="`maxDownload-${draft.id}`"
                    v-model="draft.maxDownload"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    :disabled="readOnly"
                    class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
                    placeholder="如 100 GB"
                    title="支持单位：B, KB, MB, GB, TB；填 0 表示不限"
                    @blur="normalizeSize('maxDownload')"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-xs text-gray-500" :for="`usedDownload-${draft.id}`">已使用</label>
                  <input
                    :id="`usedDownload-${draft.id}`"
                    v-model="draft.usedDownload"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    :disabled="readOnly"
                    class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
                    placeholder="如 1.5 GB"
                    title="支持单位：B, KB, MB, GB, TB"
                    @blur="normalizeSize('usedDownload')"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- 底部 -->
          <div class="flex items-center gap-2 border-t border-gray-100 px-4 py-3">
            <button
              v-if="!readOnly"
              type="button"
              class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              :disabled="changingPwd"
              @click="emit('change-password')"
            >
              {{ changingPwd ? '处理中…' : '修改密码' }}
            </button>
            <button
              v-if="canDelete"
              type="button"
              class="rounded-lg px-3 py-2 text-xs font-medium text-white transition-colors disabled:opacity-50"
              :class="confirmingDelete ? 'bg-red-700' : 'bg-red-600 hover:bg-red-700'"
              :disabled="deleting"
              @click="onDeleteClick"
            >
              {{ deleting ? '删除中…' : (confirmingDelete ? '确认删除？' : '删除') }}
            </button>

            <span class="flex-1" />

            <button
              type="button"
              class="rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
              @click="close"
            >
              {{ readOnly ? '关闭' : '取消' }}
            </button>
            <button
              v-if="!readOnly"
              type="button"
              class="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
              :disabled="saving"
              @click="emit('save', { ...draft })"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script lang="ts">
/** 列表行与弹窗草稿共用的用户类型（容量字段是带单位的显示字符串） */
export interface DbUser {
  id: number
  email: string
  username: string
  created_at: string
  IsAdmin: number | boolean
  IsSuperAdmin: number | boolean
  usedStorage: number | string
  maxStorage: number | string
  usedDownload: number | string
  maxDownload: number | string
  expire_at: string | null
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  PencilSquareIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  StarIcon,
  XMarkIcon
} from '@heroicons/vue/24/outline'
import { formatBytes, parseBytes } from '~/utils/size'
import { parseExpireAt } from '~/utils/datetimeLocal'

type SizeKey = 'maxStorage' | 'usedStorage' | 'maxDownload' | 'usedDownload'

const props = defineProps<{
  open: boolean
  user: DbUser | null
  /** 普通管理员打开管理员/超管时为 true：全部控件只读 */
  readOnly?: boolean
  canDelete?: boolean
  /** 是否允许勾选超级管理员（非超管一律 false） */
  canGrantSuper?: boolean
  saving?: boolean
  deleting?: boolean
  changingPwd?: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [draft: DbUser]
  delete: []
  'change-password': []
}>()

const displayName = computed(() => props.user?.username || props.user?.email || '未命名')

/**
 * 草稿是弹窗内部的一份拷贝，不是直接改列表行。
 * 这样关掉弹窗就等于放弃改动 —— 之前行内 v-model 绑 u.maxStorage 的时候，
 * 改到一半点别处就存进去了，没有「取消」这个概念。
 */
const draft = ref<DbUser | null>(null)
const confirmingDelete = ref(false)

watch(
  () => [props.open, props.user] as const,
  ([open, u]) => {
    if (!open || !u) {
      draft.value = null
      confirmingDelete.value = false
      return
    }
    draft.value = {
      ...u,
      IsAdmin: !!u.IsAdmin,
      IsSuperAdmin: !!u.IsSuperAdmin
    }
    confirmingDelete.value = false
  },
  { immediate: true }
)

function close() {
  if (props.saving || props.deleting) return
  confirmingDelete.value = false
  emit('close')
}

/** 两段式删除确认：第一次点变成「确认删除？」，再点才真发请求 */
function onDeleteClick() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  confirmingDelete.value = false
  emit('delete')
}

/** 失焦时把「1024 kb」规范成「1 MB」 */
function normalizeSize(key: SizeKey) {
  if (!draft.value) return
  draft.value[key] = formatBytes(parseBytes(draft.value[key] as string | number))
}

/**
 * blur 时只做**格式校验 + 补秒**，不做时区转换。
 *
 * 以前这里调 fromDatetimeLocal 再把结果写回 v-model，于是用户输入的本地墙钟
 * 被减掉 TimeZone 偏移后**直接显示在输入框里** —— 填「明天 9 点」，松手变成
 * 「明天 1 点」。时区转换只在保存时做一次（父组件的 submit），输入框里始终
 * 是用户填的本地时间。
 *
 * 秒位要先补再校验：datetime-local 在没碰秒的时候给的是 "2027-01-01T09:00"，
 * 而 parseExpireAt 的正则要求 6 段（含秒）。不补就等于把用户刚填的值判成非法
 * 然后清空 —— 表现就是「改了没反应」。
 */
function normalizeExpire() {
  if (!draft.value) return
  const raw = (draft.value.expire_at ?? '').toString().trim()
  if (!raw) {
    draft.value.expire_at = ''
    return
  }
  // 与 fromDatetimeLocal 同一套规则：补秒后再校验
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw
  if (!parseExpireAt(withSeconds)) {
    draft.value.expire_at = ''
    return
  }
  draft.value.expire_at = withSeconds
}
</script>

<style scoped>
/* 与 ShareDialog 的 .share-modal 同一套参数，保持两个弹窗手感一致 */
.user-modal-enter-active,
.user-modal-leave-active {
  transition: opacity 0.18s ease;
}
.user-modal-enter-active > div:last-child,
.user-modal-leave-active > div:last-child {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.user-modal-enter-from,
.user-modal-leave-to {
  opacity: 0;
}
.user-modal-enter-from > div:last-child,
.user-modal-leave-to > div:last-child {
  transform: translateY(16px);
}
@media (min-width: 640px) {
  .user-modal-enter-from > div:last-child,
  .user-modal-leave-to > div:last-child {
    transform: scale(0.97);
  }
}
</style>
