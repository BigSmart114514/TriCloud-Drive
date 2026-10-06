<template>
  <!--
    全局「问一句」弹窗。app.vue 挂一次，任何地方 await openPrompt() 即可。

    骨架与 ShareDialog / AccountEditDialog 同一套：Teleport 到 body +
    Transition 驱动。**不要改成 v-if 挂载**（share-management 那次踩过）：
    离场动画靠元素留在原地、只把 open 翻 false 才播得出来。
    这里 open 就是 `request !== null`，同理。
  -->
  <Teleport to="body">
    <Transition name="prompt-modal">
      <div
        v-if="request"
        class="fixed inset-0 z-[70] flex items-end justify-center sm:items-center"
        @keydown.esc="cancelPrompt()"
      >
        <div class="absolute inset-0 bg-gray-900/40" aria-hidden="true" @click="cancelPrompt()" />

        <div
          class="ui-glass relative flex w-full max-w-md flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <div class="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <component :is="icon" class="h-4 w-4 shrink-0 text-gray-500" />
                <span class="min-w-0 truncate">{{ title }}</span>
              </h2>
              <p v-if="hint" class="mt-1 text-xs leading-relaxed text-gray-500">{{ hint }}</p>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              aria-label="关闭"
              title="关闭"
              @click="cancelPrompt()"
            >
              <XMarkIcon class="h-5 w-5" />
            </button>
          </div>

          <form class="px-4 py-4" @submit.prevent="submitPrompt()">
            <label :for="inputId" class="mb-1.5 block text-xs font-medium text-gray-700">
              {{ label || title }}
            </label>
            <div class="relative">
              <input
                :id="inputId"
                ref="inputRef"
                v-model="request.value"
                :type="inputType"
                :placeholder="request.placeholder"
                autocomplete="off"
                spellcheck="false"
                class="w-full rounded-md border px-3 py-2 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                :class="request.error
                  ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
                  : 'border-gray-200'"
                @input="request.error = ''"
              />
              <!--
                显示/隐藏。默认隐藏（:type 由 request.secret 决定）。

                加它是因为「打错一个字符然后登不上」是这类表单最常见的求助，
                而排查的唯一办法就是把密码念出来。但**默认一定��隐藏** ——
                secret 的全部意义就在这里。
              -->
              <button
                v-if="request.secret"
                type="button"
                class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                :aria-label="revealed ? '隐藏' : '显示'"
                :title="revealed ? '隐藏' : '显示'"
                @click="toggleReveal()"
              >
                <component :is="revealed ? EyeSlashIcon : EyeIcon" class="h-4 w-4" />
              </button>
            </div>

            <p
              v-if="request.error"
              class="mt-1.5 flex items-start gap-1 text-xs text-red-600"
              role="alert"
            >
              <ExclamationCircleIcon class="mt-px h-3.5 w-3.5 shrink-0" />
              {{ request.error }}
            </p>
          </form>

          <div class="flex items-center gap-2 border-t border-gray-100 px-4 py-3">
            <span class="flex-1" />
            <button
              type="button"
              class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
              @click="cancelPrompt()"
            >
              {{ request.cancelText || '取消' }}
            </button>
            <button
              type="button"
              class="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
              @click="submitPrompt()"
            >
              {{ request.confirmText || '确定' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  ExclamationCircleIcon,
  EyeIcon,
  EyeSlashIcon,
  FolderPlusIcon,
  PencilSquareIcon,
  QuestionMarkCircleIcon
} from '@heroicons/vue/24/outline'
import { cancelPrompt, submitPrompt, usePromptDialog } from '~/composables/usePromptDialog'

/**
 * 状态在 usePromptDialog 的模块单例里，所以这个组件不需要 props。
 * app.vue 挂一次即可 —— 提问点散在两个页面 + 两个组件，props 往上传要挂 4 次。
 */
const { request } = usePromptDialog()

const inputRef = ref<HTMLInputElement | null>(null)
/** 密码框的「显示」开关。每次开新问题都复位 —— 上一题露着，下一题不该接着露。 */
const revealed = ref(false)

const inputId = 'prompt-dialog-input'

const title = computed(() => request.value?.title ?? '')
const label = computed(() => request.value?.label ?? '')
const hint = computed(() => request.value?.hint ?? '')

/** 标题旁的图标按类型挑。只是为了扫一眼能区分，不必每次都对 */
const icon = computed(() => {
  const t = request.value?.title ?? ''
  if (t.includes('文件夹') && t.includes('新建')) return FolderPlusIcon
  if (t.includes('重命名') || t.includes('名称')) return PencilSquareIcon
  return QuestionMarkCircleIcon
})

/**
 * 打开时聚焦并全选。
 *
 * 全选是照搬原生 `window.prompt` 的行为，而它在改名场景里是刚需：用户几乎总是
 * 整段替换而不是接着改，光有光标在末尾的话「a.txt」得手动删 4 个字符。
 *
 * 必须在 nextTick 之后 —— Teleport + v-if 的内容这一帧还没进 DOM。
 */
watch(request, async (r) => {
  revealed.value = false
  if (!r) return
  await nextTick()
  const el = inputRef.value
  if (!el) return
  el.focus()
  el.select()
})

/**
 * 实际渲染的 input type。
 *
 * `secret && !revealed` 才是 password。所以默认一定隐藏，而「显示」只是一个
 * 用户主动按出来的状态。
 */
const inputType = computed(() =>
  request.value?.secret && !revealed.value ? 'password' : 'text'
)

/**
 * 切换明文。
 *
 * 翻 type 属性会丢选区（浏览器把光标收回到末尾），所以把选区存取一遍再还原 ——
 * 否则用户在密码中间按一下「显示」，接着按方向键就从末尾开始跳了。
 */
async function toggleReveal() {
  const el = inputRef.value
  const start = el?.selectionStart ?? null
  const end = el?.selectionEnd ?? null
  revealed.value = !revealed.value
  await nextTick()
  const after = inputRef.value
  if (!after) return
  after.focus()
  // type=password 的 selectionStart 在部分浏览器里是 null，所以两个都要判
  if (start !== null && end !== null) {
    try {
      after.setSelectionRange(start, end)
    } catch {
      // number 类型的 input 不支持 setSelectionRange（我们只有 password/text，
      // 所以不该走到）；真走到就只保焦点，不保选区。
    }
  }
}
</script>

<style scoped>
.prompt-modal-enter-active,
.prompt-modal-leave-active {
  transition: opacity 0.18s ease;
}
.prompt-modal-enter-active > div:last-child,
.prompt-modal-leave-active > div:last-child {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.prompt-modal-enter-from,
.prompt-modal-leave-to {
  opacity: 0;
}
.prompt-modal-enter-from > div:last-child,
.prompt-modal-leave-to > div:last-child {
  transform: translateY(16px);
}
</style>