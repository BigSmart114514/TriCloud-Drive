<template>
  <div class="flex h-full min-h-0 flex-col bg-gray-50">
    <div class="border-b bg-white px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs text-gray-500">压缩包内容</p>
          <p class="truncate text-sm font-medium text-gray-900">{{ archiveName }}</p>
        </div>
        <input
          v-model="search"
          class="w-full rounded-md border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 sm:w-56"
          placeholder="搜索当前目录"
          type="search"
        />
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
        <nav class="flex min-w-0 flex-wrap items-center gap-1">
          <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
            <span v-if="index > 0" class="text-gray-300">/</span>
            <button class="max-w-[12rem] truncate hover:text-indigo-600" :class="{ 'font-medium text-indigo-600': index === breadcrumbs.length - 1 }" @click="emit('go-to-path', crumb.path)">
              {{ crumb.name }}
            </button>
          </template>
        </nav>
        <span>{{ totalCount }} 项<span v-if="visibleCount !== totalCount"> · 当前显示 {{ visibleCount }} 项</span></span>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
      <div v-if="error" class="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</div>
      <div v-if="skippedCount > 0" class="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
        已跳过 {{ skippedCount }} 个路径不安全或超出限制的条目。
      </div>
      <FileList
        v-if="!error"
        :folders="visibleFolders"
        :files="visibleFiles"
        :loading="loading"
        :selectable="false"
        :show-actions="false"
        :empty-title="search.trim() ? '没有匹配项' : '压缩包为空'"
        :empty-description="search.trim() ? '试试其他关键词。' : '当前目录没有文件或文件夹。'"
        @navigate-folder="emit('navigate-folder', $event)"
        @preview-file="emit('preview-file', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
// 压缩包预览的**界面**。zip 与 7z 两个预览器共用这一份。
//
// ## 为什么要抽出来
//
// 这 48 行模板原先在 ZipPreview.vue 与 SevenZipPreview.vue 里逐字节相同
// （`diff` 0 行差异），而两个预览器的行为本该完全一致 —— 它们用同一个
// useArchiveTree、解析出的记录喂给同一套树。改一处忘一处，界面就分叉了。
//
// 上一次抽的是树逻辑（useArchiveTree），剩下的是模板。这次补上。
//
// ## 边界：只渲染，不做事
//
// 数据全靠 props 进来，交互全靠 emit 出去 —— 本组件里没有一行逻辑，
// 也不持有状态（`search` 是 defineModel，双向绑定由父组件的 useArchiveTree 拥有）。
//
// 刻意**不**把 useArchiveTree 的返回整个当一个 prop 传进来（`:tree="tree"`）：
// 那些是 Ref，setupState 只对**顶层**绑定解包，嵌套在普通对象里的 Ref 在模板里
// 不解包，`tree.search` 会渲染成 [object Object]。要传就得逐个解构，那正是
// 现在父组件里那 11 行解构 —— 与其藏在 `:tree` 里让人踩坑，不如写成显式 props。
//
// 因此父组件那边也顺带从 `const { ...11 项 } = useArchiveTree()` 变成
// `const tree = useArchiveTree(...)` + 显式绑定，树本身仍然只有一份。
//
// 格式相关的东西一律不在这里：zip.js 的 entry 读取、7z-wasm 的 `l -slt` 解析，
// 各自留在自己的组件里 —— 那些差异是真实的，不该统一。
import FileList from '~/components/FileList.vue'
import type { FileListFile, FileListFolder } from '~~/types/file-list'
import type { ArchiveCrumb } from '~/composables/useArchiveTree'

defineProps<{
  /** 压缩包文件名，显示在标题栏 */
  archiveName: string
  breadcrumbs: ArchiveCrumb[]
  totalCount: number
  /** 过滤后实际显示的条数。与 totalCount 不同时标题栏会补一句「当前显示 N 项」 */
  visibleCount: number
  /** 非空时显示红条，并隐藏列表（v-if="!error"） */
  error: string
  /** 因路径不安全或超出条目上限被丢弃的条数，> 0 时显示黄条 */
  skippedCount: number
  loading: boolean
  visibleFolders: FileListFolder[]
  visibleFiles: FileListFile[]
}>()

/** 搜索词。双向绑到父组件的 useArchiveTree().search —— 状态归父，本组件不留 */
const search = defineModel<string>('search', { required: true })

const emit = defineEmits<{
  /** 点面包屑。path 为 '' 表示回根 */
  'go-to-path': [path: string]
  /** 双击文件夹。父组件用 tree.navigateFolder 处理 */
  'navigate-folder': [folder: FileListFolder]
  /** 点文件。父组件 findFile 后转成 ArchiveFileItem 再 emit 出去 */
  'preview-file': [file: FileListFile]
}>()
</script>
