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
              <!--
                同 ShareDialog 的标题行：固定文案必须 shrink-0，否则 flex 会把它
                压到比一个字还窄，中文于是在字间断行、竖着排；名字那一侧要
                min-w-0，truncate 才会真的生效（flex 子项的 min-width 默认 auto
                = 内容宽度，不放开就永远不触发省略号）。
              -->
              <h2 class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <PencilSquareIcon class="h-4 w-4 shrink-0 text-gray-500" />
                <span class="shrink-0 whitespace-nowrap">编辑用户</span>
                <span class="min-w-0 truncate font-normal text-gray-500" :title="displayName">{{ displayName }}</span>
              </h2>
              <p class="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                <span class="shrink-0">ID {{ draft.id }}</span>
                <template v-if="draft.email">
                  <span class="shrink-0 text-gray-300">·</span>
                  <span class="min-w-0 truncate" :title="draft.email">{{ draft.email }}</span>
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
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
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

                <!--
                  「可创建子账户」放在角色这一栏里，而不是额度那几段下面 ——
                  它管的是「这个人能不能管别人的账号」，和「管理员/超管」是同一类
                  开关。默认关：不给这个开关，任何登录用户都能建子账号、把文件分享
                  出去，外部访客下载消耗的是他（作为主账号）的池。
                  这一格只读时给 title 说明为什么，不能只置灰。
                -->
                <label
                  class="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-3 py-2.5 transition-colors has-[:checked]:border-indigo-300 has-[:checked]:bg-indigo-50"
                  :class="subFieldClass"
                  :title="subTitle"
                >
                  <input
                    v-model="draft.canSubAccount"
                    type="checkbox"
                    :disabled="readOnly || isChild"
                    class="h-4 w-4 rounded border-gray-300 text-indigo-600"
                  />
                  <span class="flex min-w-0 items-center gap-1.5 text-sm text-gray-800">
                    <UserGroupIcon class="h-4 w-4 shrink-0 text-indigo-500" />
                    可创建子账户
                  </span>
                </label>
              </div>
            </fieldset>

            <!--
              「最多子账户数」独立一块，因为它是数量不是角色：勾不勾
              canSubAccount 都���先填好，上限才有意义（关掉开关时已建的
              孩子仍然可见可管，见 /accounts）。

              0 = 不限，与 maxStorage/maxDownload 同口径。**不写 1 那种默认值**：
              users 表的默认是 1，写死成 1 等于「只能建一个」，用户还以为是 bug。
            -->
            <div :class="readOnly ? 'opacity-60' : ''">
              <label class="mb-2 block text-xs font-medium uppercase tracking-wider text-gray-500">
                可创建子账户数
              </label>
              <input
                v-model.number="draft.maxSubAccount"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                :disabled="readOnly || isChild"
                class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
                placeholder="0（不限）"
                :title="isChild ? '子账户不能再创建下级账户' : '0 表示不限。已创建的子账户不会因为调小这个数而消失'"
              />
              <p class="mt-1.5 text-xs text-gray-400">
                0 表示不限。调小这个数不会删掉已建的子账户，只会挡住新建。
              </p>
            </div>

            <!--
              额度三段抽到 QuotaFields 里了：/accounts 的子账户弹窗要同一套控件。
              抄一份的代价是「0 表示不限」这个约定、@blur 归一化、单位解析
              都要改两个文件 —— 而漏改的那个不报错，只是用户填的 10GB 变成
              10 字节。
            -->
            <QuotaFields
              v-model="draft"
              :read-only="readOnly"
              :show-used="true"
            />

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
  UserGroupIcon,
  XMarkIcon
} from '@heroicons/vue/24/outline'
import QuotaFields from '~/components/QuotaFields.vue'

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
 * 这一行本身是不是子账户。子账户不能再有下级（服务端强制一层），
 * 所以「可创建子账户」这两个控件对它是死设置 —— 置灰并说清为什么，
 * 而不是让管理员勾上一个服务端会忽略的值。
 */
const isChild = computed(() => props.user?.parent_id != null)

const subFieldClass = computed(() => {
  if (props.readOnly) return 'cursor-not-allowed opacity-60'
  if (isChild.value) return 'cursor-not-allowed opacity-60'
  return 'cursor-pointer hover:bg-gray-50'
})

const subTitle = computed(() => {
  if (isChild.value) return '子账户不能再创建下级账户'
  if (props.readOnly) return '当前为只读'
  return undefined
})

/**
 * 草稿是弹窗内部的一份拷贝，不是直接改列表行。
 * 这样关掉弹窗就等于放弃改动 —— 之前行内 v-model 绑 u.maxStorage 的时候，
 * 改到一半点别处就存进去了，没有「取消」这个概念。
 */
const draft = ref<DbUser | null>(null)
// 两段式删除确认的实现在 app/composables/useTwoStepConfirm.ts（与 AccountEditDialog 共用）
const { confirming: confirmingDelete, reset: resetDeleteConfirm, click: clickDeleteConfirm } =
  useTwoStepConfirm()

watch(
  () => [props.open, props.user] as const,
  ([open, u]) => {
    if (!open || !u) {
      draft.value = null
      resetDeleteConfirm()
      return
    }
    draft.value = {
      ...u,
      IsAdmin: !!u.IsAdmin,
      IsSuperAdmin: !!u.IsSuperAdmin,
      // 后端用 COALESCE 兜底：老前端不传这两个时不清零。
      // 这里仍然要显式带上，否则管理员改一次额度会顺手把人的建号能力关了。
      canSubAccount: !!u.canSubAccount,
      maxSubAccount: Number(u.maxSubAccount ?? 0)
    }
    resetDeleteConfirm()
  },
  { immediate: true }
)

function close() {
  if (props.saving || props.deleting) return
  resetDeleteConfirm()
  emit('close')
}

/** 两段式删除确认：第一次点变成「确认删除？」，再点才真发请求 */
function onDeleteClick() {
  clickDeleteConfirm(() => emit('delete'))
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
