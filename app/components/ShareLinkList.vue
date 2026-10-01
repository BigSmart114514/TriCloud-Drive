<template>
  <!--
    侧栏的「分享链接」段。一链接一行，**不与用户合并** ——
    一个目录既可能授权给某人、又可能挂了链接，那是两个独立入口，
    合并成一行就说不清「我现在看的是谁的授权」。

    名字来自 resolve 接口（每次进页面验一次，不缓存）：
    属主改了名这里跟着变，而缓存名字就得在每次列表刷新时多发一批请求。
  -->
  <!--
    无条件渲染：原先是 `v-if="links.length || loading"`，于是「还没有收藏的分享
    链接」那段空态提示永远走不到 —— 它在一个不渲染的 section 里面。
    空态是有用的信息（告诉用户这个功能存在、以及怎么用），不能因为列表空就消失。
  -->
  <section class="border-b border-gray-100">
    <div class="flex items-center justify-between px-4 py-2 text-xs font-medium text-gray-500">
      <span class="flex items-center gap-1.5">
        <LinkIcon class="h-4 w-4" />
        {{ loading ? '校验中…' : `分享链接${links.length ? ` (${links.length})` : ''}` }}
      </span>
    </div>

    <ul v-if="links.length" class="space-y-1 px-2 pb-3">
      <li v-for="l in links" :key="l.token">
        <div
          class="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors"
          :class="[
            l.active ? 'hover:bg-gray-100' : '',
            selectedToken === l.token ? 'bg-indigo-50 ring-1 ring-indigo-200' : ''
          ]"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            :disabled="l.checking"
            :aria-current="selectedToken === l.token ? 'true' : undefined"
            @click="emit('select', l.token)"
          >
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
              :class="selectedToken === l.token ? 'bg-indigo-600' : 'bg-gradient-to-br from-indigo-400 to-indigo-500'"
            >
              <LinkIcon class="h-5 w-5" />
            </span>

            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-sm font-medium text-gray-900">
                  {{ l.checking ? '校验中…' : (l.name || '未命名') }}
                </span>
              </span>
              <span v-if="!l.active" class="mt-0.5 block truncate text-xs text-amber-600" :title="l.reason || ''">
                当前不可用
              </span>
              <span v-else class="mt-0.5 block truncate text-xs text-gray-500">
                查看和下载
              </span>
            </span>

            <ChevronRightIcon
              class="h-4 w-4 shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5"
              :class="selectedToken === l.token ? 'text-indigo-500' : ''"
            />
          </button>

          <!--
            取消收藏 = 只从本地存储删，不动服务端。
            这条链接可能还有别人在用（属主也可以之后再发给别人），
            撤销它得去 ShareDialog 里，那才是服务端的事。
          -->
          <!--
            取消收藏。默认 hover 才显形，但**触屏没有 hover**，那样这个按钮
            等于不存在（opacity-0 仍然占位可点，但完全看不见）。
            所以用 @media (hover: none) 让无 hover 的设备常显。
          -->
          <button
            type="button"
            class="share-link-remove shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 focus:opacity-100"
            :aria-label="`从侧栏移除 ${l.name || '该分享链接'}`"
            title="从侧栏移除（不会撤销链接本身）"
            @click.stop="emit('remove', l.token)"
          >
            <XMarkIcon class="h-4 w-4" />
          </button>
        </div>
      </li>
    </ul>

    <p v-else-if="!loading" class="px-4 pb-4 text-xs text-gray-400">
      还没有收藏的分享链接。
    </p>
  </section>
</template>

<script setup lang="ts">
import { ChevronRightIcon, LinkIcon, XMarkIcon } from '@heroicons/vue/24/outline'

export interface ShareLinkEntry {
  token: string
  /** 校验回来的目标名。checking 期间是空串 */
  name: string
  /** 当前能不能用。false = 链接和目标都在，但被边界判定挡住（属主可能修好） */
  active: boolean
  reason: string | null
  checking: boolean
}

const props = withDefaults(defineProps<{
  links: ShareLinkEntry[]
  selectedToken?: string | null
  loading?: boolean
}>(), {
  selectedToken: null,
  loading: false
})

const emit = defineEmits<{
  select: [token: string]
  remove: [token: string]
}>()
</script>

<style scoped>
/**
 * 取消收藏按钮：指针设备 hover 才显形（少一条常驻的灰 X，视觉噪音小），
 * 无 hover 的设备（触屏）常显 —— 否则它看不见也等于是不存在的。
 */
.share-link-remove {
  opacity: 0;
}
@media (hover: hover) and (pointer: fine) {
  .share-link-remove {
    opacity: 0;
  }
  .group:hover .share-link-remove,
  .share-link-remove:focus-visible {
    opacity: 1;
  }
}
@media not all and (hover: hover) {
  .share-link-remove {
    opacity: 1;
  }
}
</style>