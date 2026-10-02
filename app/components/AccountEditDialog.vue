<template>
  <Teleport to="body">
    <!--
      与 ShareDialog / UserEditDialog 同一套弹窗骨架：
      Teleport 到 body + Transition 驱动。
      **不要改成 v-if 挂载**（share-management 那次踩过）：离场动画靠元素
      留在原地、只把 open 翻 false 才播得出来。
    -->
    <Transition name="account-modal">
      <div v-if="open" class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
        <div class="absolute inset-0 bg-gray-900/40" aria-hidden="true" @click="close" />

        <div
          class="ui-glass relative flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="编辑子账户"
        >
          <div class="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <UserGroupIcon class="h-4 w-4 shrink-0 text-gray-500" />
                <span class="shrink-0 whitespace-nowrap">编辑子账户</span>
                <span class="min-w-0 truncate font-normal text-gray-500" :title="displayName">{{ displayName }}</span>
              </h2>
              <p class="mt-0.5 text-xs text-gray-500">
                容量与下载流量从这个账号自己的额度里扣，同时受主账号共享容量限制。
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

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <!--
              额度三段复用 QuotaFields（与用户管理里同一个组件）。
              「已使用」置只读：这个数字由实际文件/下载累计出来，
              改了服务端也不认（accounts/quota.post.ts 的字段白名单里没有它）。
            -->
            <QuotaFields v-model="draft" :show-used="true" :used-read-only="true" />
          </div>

          <div class="flex items-center gap-2 border-t border-gray-100 px-4 py-3">
            <button
              type="button"
              class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              :disabled="saving || deleting"
              @click="emit('reset-password')"
            >
              重置密码
            </button>
            <button
              v-if="canDelete"
              type="button"
              class="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
              :disabled="saving || deleting"
              @click="onDeleteClick"
            >
              {{ confirmingDelete ? '确认删除？' : '删除' }}
            </button>
            <span class="flex-1" />
            <button
              type="button"
              class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
              :disabled="saving"
              @click="close"
            >
              取消
            </button>
            <button
              type="button"
              class="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
              :disabled="saving || !draft"
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

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { UserGroupIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import QuotaFields, { type QuotaDraft } from '~/components/QuotaFields.vue'
import type { SubAccount } from '~/services/account.service'
import { formatBytes } from '~/utils/size'
import { toDatetimeLocal } from '~/utils/datetimeLocal'

/**
 * 草稿形状 = QuotaFields 要的字段 + 一个已使用（只读展示用）。
 * 与 users 表同名列，服务端 quota.post.ts 按同名字段接收。
 */
export type AccountDraft = QuotaDraft

const props = defineProps<{
  open: boolean
  child: SubAccount | null
  saving?: boolean
  deleting?: boolean
  canDelete?: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [draft: AccountDraft]
  delete: []
  'reset-password': []
}>()

const displayName = computed(() => props.child?.username || props.child?.email || '未命名')

const draft = ref<AccountDraft | null>(null)
const confirmingDelete = ref(false)

watch(
  () => [props.open, props.child] as const,
  ([open, c]) => {
    if (!open || !c) {
      draft.value = null
      confirmingDelete.value = false
      return
    }
    draft.value = {
      id: c.id,
      // 列表里是字节（数字），弹窗里统一成「10 GB」这种带单位的显示串，
      // 与用户管理那边一致，父组件保存时再 parseBytes 回去
      maxStorage: formatBytes(c.maxStorage),
      usedStorage: formatBytes(c.usedStorage),
      maxDownload: formatBytes(c.maxDownload),
      usedDownload: formatBytes(c.usedDownload),
      expire_at: toDatetimeLocal(c.expireAt)
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

/** 两段式删除确认，与 UserEditDialog 同一套：第一次变成「确认删除？」 */
function onDeleteClick() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  confirmingDelete.value = false
  emit('delete')
}
</script>

<style scoped>
/* 与 UserEditDialog / ShareDialog 同一套参数，保持三个弹窗手感一致 */
.account-modal-enter-active,
.account-modal-leave-active {
  transition: opacity 0.18s ease;
}
.account-modal-enter-active > div:last-child,
.account-modal-leave-active > div:last-child {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.account-modal-enter-from,
.account-modal-leave-to {
  opacity: 0;
}
.account-modal-enter-from > div:last-child,
.account-modal-leave-to > div:last-child {
  transform: translateY(12px);
}
</style>