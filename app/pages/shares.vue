<template>
  <AppNavbar />

  <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <h1 class="text-lg font-semibold text-gray-900">分享管理</h1>
      <button
        type="button"
        class="shrink-0 rounded-md p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
        aria-label="刷新列表"
        title="刷新列表"
        :disabled="loading"
        @click="load"
      >
        <ArrowPathIcon class="h-5 w-5" />
      </button>
    </div>

    <!--
      摘要。数字来自服务端的独立统计（不带列表上限），所以这里说「一共设置了
      多少」，下面即使只列 200 条也不矛盾。链接数后面挂「其中打不开几条」，
      因为死链是这一页最需要被看见的事，只给总数会把它埋掉。
    -->
    <p v-if="summary" class="mb-3 text-sm text-gray-600">
      <template v-if="summary.total === 0">
        还没有设置过任何分享。
      </template>
      <template v-else>
        共设置 {{ summary.total }} 项
        <span v-if="summary.publicCount">，{{ summary.publicCount }} 项公开</span>
        <span v-if="summary.privateCount">，{{ summary.privateCount }} 项设为不分享</span>
        <span v-if="summary.linkCount">
          ，{{ summary.linkCount }} 条分享链接<template v-if="summary.deadLinkCount">（{{ summary.deadLinkCount }} 条打不开）</template>
        </span>。
      </template>
    </p>

    <p v-if="truncated" class="mb-3 text-xs text-amber-600">
      设置的项数超过一次能列出的上限，这里只显示其中一部分。
      缩小筛选范围或分批处理，避免漏改。
    </p>

    <!--
      筛选全在本地做：列表本身有上限，筛选不需要再发请求，输入即出结果。
      三项各管一件事 —— 类型切分、状态下钻、名称定位。
    -->
    <div v-if="summary && summary.total > 0" class="mb-3 flex flex-wrap items-center gap-2">
      <div class="flex rounded-md border border-gray-200 bg-white p-0.5">
        <button
          v-for="opt in TYPE_FILTERS"
          :key="opt.value"
          type="button"
          class="rounded px-2.5 py-1 text-xs font-medium transition-colors"
          :class="typeFilter === opt.value ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-100'"
          @click="typeFilter = opt.value"
        >
          {{ opt.label }}
        </button>
      </div>

      <select
        v-model="stateFilter"
        class="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        aria-label="按状态筛选"
      >
        <option v-for="opt in STATE_FILTERS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>

      <div class="relative min-w-40 flex-1">
        <MagnifyingGlassIcon
          class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
        />
        <input
          v-model="keyword"
          type="search"
          class="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          placeholder="查找名字或位置"
          aria-label="查找名字或位置"
        />
        <button
          v-if="keyword"
          type="button"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          aria-label="清空"
          @click="keyword = ''"
        >
          <XMarkIcon class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- 全选。只在筛选后仍有可见项时给 —— 对着空列表全选没有意义 -->
    <label v-if="visibleRows.length" class="mb-2 flex items-center gap-2 text-xs text-gray-600">
      <input
        ref="masterCheckboxRef"
        type="checkbox"
        class="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        :checked="isAllVisibleSelected"
        @change="toggleSelectAll"
      />
      全选<span v-if="selectedCount">（已选 {{ selectedCount }} / {{ visibleRows.length }}）</span>
    </label>

    <div class="rounded-lg border border-gray-200 bg-white">
      <ShareSettingList
        :folders="visibleFolders"
        :files="visibleFiles"
        :loading="loading"
        :selected-ids="selectedIds"
        :empty-title="emptyTitle"
        :empty-description="emptyDescription"
        @open="openSetting"
        @locate="locate"
        @toggle="toggleRow"
      />
    </div>

    <!--
      批量操作条。破坏性动作的确认交给 confirm()（与 useBulkActions、
      ShareDialog 撤销链接同一套做法），文案必须写清后果 —— 尤其
      「已发出去的链接会立刻失效」，那是用户事后才会发现的事。
    -->
    <div
      v-if="selectedCount > 0"
      class="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 backdrop-blur"
    >
      <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6 lg:px-8">
        <span class="text-sm text-gray-700">已选 {{ selectedCount }} 项</span>
        <button
          v-for="action in BULK_ACTIONS"
          :key="action.value"
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
          :class="action.danger
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-indigo-600 text-white hover:bg-indigo-700'"
          :disabled="bulkBusy"
          @click="runBulk(action.value)"
        >
          {{ action.label }}
        </button>
        <button
          type="button"
          class="ml-auto rounded-md px-2 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-800"
          :disabled="bulkBusy"
          @click="clearSelection"
        >
          清除选择
        </button>
      </div>
    </div>
    <!-- 给固定底条留出空间，否则最后几行被盖住点不到 -->
    <div v-if="selectedCount > 0" class="h-16" />

    <!--
      分享设置弹窗。复用首页那一个：它是唯一的分享设置入口，
      这里不重造第二套表单。open 之后如果属主改了设置，changed 回来重拉列表 ——
      否则这一行会留着过期的三态和人数。

      **不要加 v-if**：ShareDialog 内部的淡出靠 Transition + :open 驱动，
      组件必须留在原地、只把 open 翻成 false，动画才有元素可以过渡。
      v-if 会把整个组件从 vdom 摘掉，弹窗瞬间消失，离场动画一帧都不播
      （曾经就这么写错过一次）。所以下面用 `?? ''` / `?? null` 兜住空态，
      让组件始终挂载。口径与 FileBrowser 里的那个完全一致。
    -->
    <ShareDialog
      :open="activeRow !== null"
      :target-type="activeRow?.targetType ?? 'folder'"
      :target-id="activeRow?.id ?? null"
      :name="activeRow?.name ?? ''"
      @close="activeRow = null"
      @changed="onSettingChanged"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowPathIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import AppNavbar from '~/components/AppNavbar.vue'
import ShareSettingList from '~/components/ShareSettingList.vue'
import ShareDialog from '~/components/ShareDialog.vue'
import {
  SHARE_BULK_ACTION_LABELS,
  ShareService,
  type ShareBulkAction,
  type ShareSettingRow,
  type ShareSettingsSummary
} from '~/services/share.service'
import { notify, notifyError } from '~/utils/notify'
import { SHARE_NONE } from '~~/types/share'

useHead({ title: '分享管理' })

const folders = ref<ShareSettingRow[]>([])
const files = ref<ShareSettingRow[]>([])
const summary = ref<ShareSettingsSummary | null>(null)
const truncated = ref(false)
const bulkBusy = ref(false)

/** 分享设置弹窗当前打开的那一项 */
const activeRow = ref<ShareSettingRow | null>(null)

/* ---------------- 筛选 ---------------- */

type TypeFilter = 'all' | 'folder' | 'file'
const typeFilter = ref<TypeFilter>('all')
const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'folder', label: '文件夹' },
  { value: 'file', label: '文件' }
]

type StateFilter = 'all' | 'public' | 'private' | 'link' | 'deadLink' | 'inactive'
const stateFilter = ref<StateFilter>('all')
/**
 * 状态下钻。选项按「需要人看一眼的程度」排，最需要处理的在前 ——
 * 这一页的用途就是找出该改的，不是展示所有状态。
 */
const STATE_FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'deadLink', label: '链接打不开' },
  { value: 'inactive', label: '设置未生效' },
  { value: 'public', label: '公开' },
  { value: 'private', label: '不分享' },
  { value: 'link', label: '有分享链接' }
]

const keyword = ref('')

const hasOwnSetting = (row: ShareSettingRow) => row.grantCount > 0 || row.isPublic

const matchState = (row: ShareSettingRow): boolean => {
  switch (stateFilter.value) {
    case 'public': return row.isPublic
    case 'private': return row.mode === SHARE_NONE
    case 'link': return row.linkCount > 0
    case 'deadLink': return row.linkCount > 0 && !row.linkActive
    case 'inactive': return !row.presetActive && hasOwnSetting(row)
    default: return true
  }
}

const matchKeyword = (row: ShareSettingRow): boolean => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return true
  // 位置也参与匹配：同名条目只能靠位置区分，只搜名字等于放弃了一半线索
  return row.name.toLowerCase().includes(q) || row.relDir.toLowerCase().includes(q)
}

const visibleFolders = computed(() =>
  typeFilter.value === 'file' ? [] : folders.value.filter((r) => matchState(r) && matchKeyword(r))
)
const visibleFiles = computed(() =>
  typeFilter.value === 'folder' ? [] : files.value.filter((r) => matchState(r) && matchKeyword(r))
)
const visibleRows = computed(() => [...visibleFolders.value, ...visibleFiles.value])

/** 空态文案要区分「本来就没有」和「筛完没有」—— 后者要告诉用户怎么回去 */
const isFiltered = computed(
  () => typeFilter.value !== 'all' || stateFilter.value !== 'all' || !!keyword.value.trim()
)
const emptyTitle = computed(() => (isFiltered.value ? '没有符合条件的项' : '还没有设置过分享'))
const emptyDescription = computed(() =>
  isFiltered.value
    ? '把筛选条件放宽一些，或清空搜索词再看看。'
    : '在「我的文件」里点分享图标，把文件或文件夹分享给别人之后，这里会列出每一项。'
)

/* ---------------- 选择 ---------------- */

/**
 * 选择集只装**当前可见**的行。
 *
 * 筛选一变就要清掉看不见的那些：否则用户筛选出 3 项、勾 2 项，切个筛选再回来
 * 会发现「已选 5 项」而其中 3 项根本不在屏幕上，批量条上的数字开始骗人。
 */
const selectedIds = ref<Set<string>>(new Set())

const rowKey = (row: ShareSettingRow) => `${row.targetType}-${row.id}`
const selectedCount = computed(() => selectedIds.value.size)
const isAllVisibleSelected = computed(
  () => visibleRows.value.length > 0 && visibleRows.value.every((r) => selectedIds.value.has(rowKey(r)))
)

const masterCheckboxRef = ref<HTMLInputElement | null>(null)
watch(
  () => visibleRows.value.length > 0 && selectedCount.value > 0 && !isAllVisibleSelected.value,
  (v) => {
    if (masterCheckboxRef.value) masterCheckboxRef.value.indeterminate = v
  },
  { immediate: true }
)

function toggleRow(row: ShareSettingRow) {
  const next = new Set(selectedIds.value)
  const key = rowKey(row)
  next.has(key) ? next.delete(key) : next.add(key)
  selectedIds.value = next
}

function toggleSelectAll() {
  selectedIds.value = isAllVisibleSelected.value
    ? new Set()
    : new Set(visibleRows.value.map(rowKey))
}

function clearSelection() {
  selectedIds.value = new Set()
}

watch([typeFilter, stateFilter, keyword], () => {
  // 见上面 selectedIds 的注释：看不见的项不该继续占着「已选」
  const visible = new Set(visibleRows.value.map(rowKey))
  selectedIds.value = new Set([...selectedIds.value].filter((k) => visible.has(k)))
})

/* ---------------- 加载 ---------------- */

const { loading, reload: load } = useAsyncResource(async () => {
  const res = await ShareService.settings()
  folders.value = res.folders ?? []
  files.value = res.files ?? []
  summary.value = res.summary ?? null
  truncated.value = !!res.truncated
}, { errorMessage: '加载分享列表失败', immediate: true })

/* ---------------- 行内操作 ---------------- */

function openSetting(row: ShareSettingRow) {
  activeRow.value = row
}

async function onSettingChanged() {
  // 弹窗里改了三态/名单/链接，这一行显示的就是过期数据了
  await load()
}

/**
 * 「在文件里打开」。
 *
 * 落点目录 id 走 URL（`/?at=<id>`）而不是内存传参：这样能收藏、能刷新、
 * 也能在自己另一个浏览器里打开。名字（面包屑要的那一串）由首页去
 * /api/folders/lineage 取 —— 目录 id 本身不含名字。
 */
async function locate(row: ShareSettingRow) {
  const folderId = row.targetType === 'folder' ? row.id : row.folderId
  if (folderId === null || folderId === undefined) return
  await navigateTo({ path: '/', query: { at: String(folderId) } })
}

/* ---------------- 批量 ---------------- */

interface BulkActionDef {
  value: ShareBulkAction
  label: string
  danger: boolean
  /** 确认文案。返回 null 表示这一项没什么可改的，不用问 */
  confirm: (targets: ShareSettingRow[]) => string | null
  done: (okCount: number, failCount: number) => string
}

const BULK_ACTIONS: BulkActionDef[] = [
  {
    value: 'reset',
    label: SHARE_BULK_ACTION_LABELS.reset,
    danger: true,
    confirm: (targets) => {
      const links = targets.reduce((n, r) => n + r.linkCount, 0)
      const folders_ = targets.filter((r) => r.targetType === 'folder').length
      const files_ = targets.length - folders_
      const parts: string[] = []
      if (folders_) parts.push(`${folders_} 个文件夹`)
      if (files_) parts.push(`${files_} 个文件`)
      let text = `把 ${parts.join('、')} 恢复默认？\n\n`
      text += '这些项会变成「继承」、取消公开、清空授权名单。'
      if (links) {
        text += `\n\n同时撤销 ${links} 条分享链接 —— 已经发出去的地址会立刻失效。`
      }
      text += '\n\n恢复默认后它们会从这一页消失。'
      return text
    },
    done: (ok, fail) =>
      fail ? `${ok} 项已恢复默认，${fail} 项没成功` : `已把 ${ok} 项恢复默认`
  },
  {
    value: 'unpublish',
    label: SHARE_BULK_ACTION_LABELS.unpublish,
    danger: false,
    confirm: (targets) => {
      const pub = targets.filter((r) => r.isPublic)
      if (!pub.length) return null
      return `取消 ${pub.length} 项的公开？\n\n「公开」= 所有已登录用户可读。授权名单和三态不变。`
    },
    done: (ok, fail) => (fail ? `${ok} 项已取消公开，${fail} 项没成功` : `已取消 ${ok} 项的公开`)
  },
  {
    value: 'removeLinks',
    label: SHARE_BULK_ACTION_LABELS.removeLinks,
    danger: true,
    confirm: (targets) => {
      const links = targets.reduce((n, r) => n + r.linkCount, 0)
      if (!links) return null
      return `撤销 ${targets.length} 项上的 ${links} 条分享链接？\n\n已经发出去的地址会立刻失效，拿到过链接的人打不开了。授权名单不受影响。`
    },
    done: (ok, fail) => (fail ? `已撤销 ${ok} 项的链接，${fail} 项没成功` : `已撤销 ${ok} 项上的分享链接`)
  }
]

async function runBulk(action: ShareBulkAction) {
  const def = BULK_ACTIONS.find((a) => a.value === action)
  if (!def) return

  // 按「文件夹在前、文件在后」的源顺序取，与屏幕上的顺序一致
  const targets = [...folders.value, ...files.value].filter((row) => selectedIds.value.has(rowKey(row)))
  if (!targets.length) return

  const question = def.confirm(targets)
  if (question === null) {
    // 没什么可改的（比如选的项里没有公开的）。说一句，别让按钮像坏了
    notify('选中的项目里没有可撤销的分享链接', 'error')
    return
  }
  if (!confirm(question)) return

  bulkBusy.value = true
  try {
    const res = await ShareService.bulk(
      targets.map((r) => ({ targetType: r.targetType, targetId: r.id })),
      action
    )
    if (res.okCount > 0) {
      notify(def.done(res.okCount, res.failCount), 'success')
      clearSelection()
      await load()
    } else {
      notify(res.failCount > 0 ? firstFailure(res.results) : '没有改动任何项目', 'error')
    }
  } catch (e: any) {
    notifyError(e, '操作失败')
  } finally {
    bulkBusy.value = false
  }
}

/** 全批失败时，把服务端给的第一条原因说出来，比「操作失败」有用 */
function firstFailure(results: Array<{ ok: boolean; message?: string }>): string {
  const failed = results.find((r) => !r.ok && r.message)
  return failed?.message || '操作失败'
}
</script>
