<template>
  <!--
    分享管理的行。两行结构：

      第一行  身份 —— 勾选 + 文件/文件夹图标 + 名字 + 右侧状态章
      第二行  为什么在列表里 —— 位置 / 人数 / 公开 / 链接 / 失效提示

    为什么要两行而不是挤在一行：这一页的信息量本身就大（位置 + 四项事实），
    挤一行必然省略号截断，而「这一项在哪」恰恰是同名条目之间唯一可靠的区分。
    位置单独占一行，名字和事实就都读得完。

    ## 整行可点，点开就是这一项的分享设置

    主操作只有这一个。行内的两个例外（勾选框、「在文件里打开」）都 stop 掉
    冒泡，免得想勾选却弹开了弹窗 —— 这是这类列表最容易踩的一脚。

    ## 为什么不用 FileList

    FileList 的行是「浏览」的行：点文件夹=进去、点文件=预览，操作区是
    改名/删除/剪贴。这一页的行是「管理」的行，点哪里都是打开设置，且**不能**
    出现删除和剪贴（在这里删一个文件是最容易出事的误操作）。
    两种行语义不同、外壳相同，硬凑成一份组件只会让两处都别扭。
    图标、日期格式化、日期本地化等底层工具仍然共用。
  -->
  <div>
    <p v-if="loading" class="py-4 text-center text-xs text-gray-400">加载中…</p>

    <div v-else-if="!rows.length" class="text-center py-8">
      <svg
        class="mx-auto h-12 w-12 text-gray-400"
        stroke="currentColor"
        fill="none"
        viewBox="0 0 48 48"
        aria-hidden="true"
      >
        <path
          d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <h3 class="mt-2 text-sm font-medium text-gray-900">{{ emptyTitle }}</h3>
      <p class="mx-auto mt-1 max-w-sm text-sm text-gray-500">{{ emptyDescription }}</p>
    </div>

    <ul v-else class="divide-y divide-gray-100">
      <li
        v-for="row in rows"
        :key="`${row.targetType}-${row.id}`"
        class="group flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-gray-50"
        :class="selectedIds.has(rowKey(row)) ? 'bg-indigo-50/40' : ''"
      >
        <input
          type="checkbox"
          class="mt-1.5 h-4 w-4 shrink-0 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          :checked="selectedIds.has(rowKey(row))"
          :aria-label="`选择 ${row.name}`"
          @change="emit('toggle', row)"
        />

        <button
          type="button"
          class="flex min-w-0 flex-1 items-start gap-3 text-left"
          :aria-label="`${row.name} 的分享设置`"
          @click="emit('open', row)"
        >
          <span class="mt-0.5 shrink-0">
            <template v-if="row.targetType === 'folder'">
              <!--
                内联 SVG 的实心文件夹图标，与 FileList 里用的一致。
                不引 FolderIcon 组件：那里的描边版式与这一行的实心版式不同，
                混进同一个列表会显得两行不是一套东西。
              -->
              <svg class="h-6 w-6 text-yellow-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M2 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
            </template>
            <FileIcon
              v-else
              class="h-6 w-6 text-gray-400"
              :filename="row.name"
            />
          </span>

          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="truncate text-sm font-medium text-gray-900">{{ row.name }}</span>

              <!--
                状态章。颜色按三态分，与 FileList 的分享角标同一套语言：
                锁=红（拒绝）、分享=绿（按名单）、公开=绿、继承=灰。
                继承态本身不算异常（默认态），所以用灰，不跟警告抢注意力。
              -->
              <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium"
                :class="modeChip(row)"
              >{{ SHARE_MODE_LABELS[row.mode] }}</span>

              <!-- 「设了但没用上」：这一项最需要人看一眼，所以给它独立的一枚 -->
              <span
                v-if="needsAttention(row)"
                class="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
                :title="attentionTitle(row)"
              >{{ attentionLabel(row) }}</span>
            </span>

            <span class="mt-0.5 block truncate text-xs text-gray-500">
              <template v-for="(fact, i) in factsOf(row)" :key="i">
                <span v-if="i > 0" class="mx-1 text-gray-300">·</span>
                <span :class="fact.warn ? 'text-amber-600' : ''">{{ fact.text }}</span>
              </template>
            </span>
          </span>
        </button>

        <!--
          「在文件里打开」。文件在根层时没有落点（根层没有目录 id），
          置灰并说明原因，而不是点一下什么都不发生。
        -->
        <button
          type="button"
          class="mt-1 shrink-0 rounded px-2 py-1 text-xs transition-colors"
          :class="canLocate(row)
            ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            : 'cursor-not-allowed text-gray-300'"
          :disabled="!canLocate(row)"
          :title="canLocate(row) ? locateTitle(row) : '这个文件在根目录，没有可打开的文件夹'"
          @click.stop="emit('locate', row)"
        >
          <span class="hidden sm:inline">在文件里打开</span>
          <FolderOpenIcon class="h-4 w-4 sm:hidden" />
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { FolderOpenIcon } from '@heroicons/vue/24/outline'
import FileIcon from '~/components/FileIcon.vue'
import type { ShareSettingRow } from '~/services/share.service'
import { SHARE_MODE_LABELS, SHARE_NONE, SHARE_SHARED } from '~~/types/share'

const props = withDefaults(defineProps<{
  folders: ShareSettingRow[]
  files: ShareSettingRow[]
  loading?: boolean
  emptyTitle?: string
  emptyDescription?: string
  /** 已选中的目标，键是 `${targetType}-${id}`。让父级掌管选择集，这里只负责显示 */
  selectedIds?: ReadonlySet<string>
}>(), {
  loading: false,
  emptyTitle: '还没有设置过分享',
  emptyDescription: '在「我的文件」里点分享图标，把文件或文件夹分享给别人之后，这里会列出每一项。',
  selectedIds: () => new Set<string>()
})

const emit = defineEmits<{
  /** 点行：打开这一项的分享设置 */
  open: [row: ShareSettingRow]
  /** 「在文件里打开」：去首页定位到它所在的目录 */
  locate: [row: ShareSettingRow]
  /** 勾选框。只改选择集，不打开弹窗 */
  toggle: [row: ShareSettingRow]
}>()

/** 目录在前、文件在后，与 FileList 的排法一致 */
const rows = computed(() => [...props.folders, ...props.files])

/** 选择集的键。加 targetType 是必需的：文件 id 5 和目录 id 5 是两回事 */
const rowKey = (row: ShareSettingRow) => `${row.targetType}-${row.id}`

const modeChip = (row: ShareSettingRow) => {
  if (row.mode === SHARE_NONE) return 'bg-red-50 text-red-700'
  if (row.mode === SHARE_SHARED) return 'bg-emerald-50 text-emerald-700'
  return 'bg-gray-100 text-gray-600'
}

/** 位置。根层没有 relDir，写「根目录」而不是留空 —— 留空看着像没加载出来 */
const locationOf = (row: ShareSettingRow) => row.relDir || '根目录'

interface Fact {
  text: string
  /** 需要人处理的事实用琥珀色，与状态章的灰/红/绿区分开 */
  warn?: boolean
}

const factsOf = (row: ShareSettingRow): Fact[] => {
  const facts: Fact[] = [{ text: locationOf(row) }]
  if (row.grantCount > 0) facts.push({ text: `${row.grantCount} 人` })
  if (row.isPublic) facts.push({ text: '公开' })
  if (row.linkCount > 0) {
    facts.push(
      row.linkActive
        ? { text: `${row.linkCount} 条链接` }
        : { text: `${row.linkCount} 条链接（打不开）`, warn: true }
    )
  }
  return facts
}

/**
 * 「设了但没用上」。
 *
 * 两种，优先级从高到低：
 *   链接打不开 —— 已经发出去的地址是死的，最该先看
 *   名单/公开没生效 —— 设了但被上级挡住，等于没设
 *
 * 本来就什么都没设的行不给这个标记：那是默认态，不是问题。
 */
const needsAttention = (row: ShareSettingRow) =>
  (row.linkCount > 0 && !row.linkActive) || (!row.presetActive && hasOwnSetting(row))

const hasOwnSetting = (row: ShareSettingRow) => row.grantCount > 0 || row.isPublic

const attentionLabel = (row: ShareSettingRow) =>
  row.linkCount > 0 && !row.linkActive ? '链接失效' : '未生效'

const attentionTitle = (row: ShareSettingRow) =>
  row.linkCount > 0 && !row.linkActive
    ? '这个分享链接现在打不开：需要把这一项或它的上级目录设为「分享」'
    : '你在这里设置的分享当前没生效：上级目录里没有「分享」，或被「不分享」挡住了'

/** 文件看所在目录，目录看自己。文件在根层时没有目录可看 */
const canLocate = (row: ShareSettingRow) =>
  row.targetType === 'folder' ? true : row.folderId !== null && row.folderId !== undefined

const locateTitle = (row: ShareSettingRow) =>
  row.targetType === 'folder' ? '在我的文件里打开这个文件夹' : '在我的文件里打开它所在的文件夹'
</script>
