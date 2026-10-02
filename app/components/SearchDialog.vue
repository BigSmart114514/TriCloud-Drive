<template>
  <Teleport to="body">
    <Transition name="search-modal">
      <div v-if="open" class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
        <div class="absolute inset-0 bg-gray-900/40" aria-hidden="true" @click="close" />

        <div
          class="ui-glass relative flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <!-- 头部：与 ShareDialog / UserEditDialog 同一套骨架，改的只有标题与图标 -->
          <div class="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <MagnifyingGlassIcon class="h-4 w-4 shrink-0 text-gray-500" />
                {{ title }}
              </h2>
              <p class="mt-0.5 text-xs text-gray-500">{{ subtitle }}</p>
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
            <div class="relative">
              <MagnifyingGlassIcon class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                ref="inputRef"
                v-model="keyword"
                type="search"
                :placeholder="placeholder"
                aria-label="搜索文件和文件夹"
                class="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-9 text-sm placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                @input="onInput"
              />
              <button
                v-if="keyword"
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                aria-label="清空关键词"
                @click="clearKeyword"
              >
                <XMarkIcon class="h-4 w-4" />
              </button>
            </div>

            <!--
              结果列表复用 FileList：图标（含按类型渲染的文件图标）、路径行、
              空状态全部白拿。selectable / showActions 关掉，搜索里不提供选择与
              增删改 —— 那些操作需要「先进入那个目录」这个上下文。
            -->
            <div class="mt-3">
              <FileList
                :folders="folderRows"
                :files="fileRows"
                :loading="searching"
                :selectable="false"
                :show-actions="false"
                :show-clip="false"
                :framed="false"
                :empty-title="emptyTitle"
                :empty-description="emptyDescription"
                @navigate-folder="onPickFolder"
                @preview-file="onPickFile"
              >
                <template #file-extra-actions="{ file }">
                  <button
                    type="button"
                    class="p-1 text-sm text-gray-600 hover:text-gray-800"
                    title="到所在文件夹"
                    aria-label="到所在文件夹"
                    @click.stop="onLocateFile(file)"
                  >
                    <FolderOpenIcon class="h-5 w-5" />
                  </button>
                </template>
              </FileList>
            </div>

            <p v-if="truncated" class="mt-3 text-center text-xs text-gray-400">
              结果较多，只显示前 {{ resultLimit }} 条。缩小关键词可以看得更全。
            </p>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { MagnifyingGlassIcon, XMarkIcon, FolderOpenIcon } from '@heroicons/vue/24/outline'
import FileList from '~/components/FileList.vue'
import { SearchService } from '~/services/search.service'
import type { SearchFileHit, SearchFolderHit, SearchPathNode, SearchScope } from '~/services/search.service'
import type { FileListFile, FileListFolder } from '~~/types/file-list'

const props = withDefaults(defineProps<{
  open: boolean
  /**
   * mine —— 只搜自己的文件（首页）
   * site —— 全站（仅超管的文件管理页）
   *
   * 这里只是传给服务端的参数，不是权限判定 —— 服务端对 site 会自己
   * 验一次 isSuperAdmin，前端传什么都不作数。
   */
  scope?: SearchScope
}>(), { scope: 'mine' })

/**
 * 选中一个结果。
 *
 *   path —— 要跳转到的目录链路（目录命中=含自己；文件命中=所在目录）
 *   file —— 带着它表示「跳过去之后再把预览打开」
 *
 * 两者合成一个事件，是因为页面对这两种落点的处理完全一样（先切属主、
 * 再跳目录），分成两个事件会让「同属主」和「跨属主」的分支写两遍。
 */
const emit = defineEmits<{
  close: []
  pick: [payload: { ownerId: number; path: SearchPathNode[]; file?: SearchFileHit }]
}>()

/** 每类的结果上限，来自服务端响应。截断文案里的 N 用它，不另抄常量 */
const resultLimit = ref(50)

const title = computed(() => (props.scope === 'site' ? '全站搜索' : '搜索我的文件'))
const subtitle = computed(() =>
  props.scope === 'site'
    ? '搜索所有人的文件和文件夹。点结果会切到它所属的用户。'
    : '按文件名或文件夹名搜索。'
)
const placeholder = computed(() =>
  props.scope === 'site' ? '输入文件名或文件夹名，搜索全站' : '输入文件名或文件夹名'
)

const keyword = ref('')
const folders = ref<SearchFolderHit[]>([])
const files = ref<SearchFileHit[]>([])
const searching = ref(false)
/**
 * 「问过一次服务端了」。
 *
 * 空结果有两种：还没搜（显示引导语），搜了但没有（显示「没有匹配项」）。
 * 不分开的话，一打开弹窗就会说「没有匹配项」，像是搜坏了。
 * ShareDialog / ManageUserList / ZipPreview 三处已有同一个做法。
 */
const searched = ref(false)
const truncated = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)
/**
 * 去抖 + 请求序号一体。去抖不等于串行 —— 慢的那次可能后到，把新的结果覆盖掉，
 * 所以 run 拿到 seq 后必须自己判 `if (id !== latest()) return`。见 useDebounced。
 */
const {
  schedule: scheduleSearch,
  cancel: cancelSearch,
  latest: latestSeq
} = useDebounced<string>({
  delay: 250,
  run: (q, id) => runSearch(q, id)
})

const folderRows = computed<FileListFolder[]>(() =>
  folders.value.map((f) => ({
    ...f,
    // 全站搜索才显示属主：mine 范围下每一行都是我自己的，写了是噪音
    ownerLabel: props.scope === 'site' ? (f.ownerLabel ?? `用户 ${f.ownerId}`) : undefined
  }))
)
const fileRows = computed<FileListFile[]>(() =>
  files.value.map((f) => ({
    ...f,
    ownerLabel: props.scope === 'site' ? (f.ownerLabel ?? `用户 ${f.ownerId}`) : undefined
  }))
)

const emptyTitle = computed(() => (searched.value ? '没有匹配项' : '输入关键词开始搜索'))
const emptyDescription = computed(() =>
  searched.value ? '换个关键词，或者用更短的一段试试。' : '文件名和文件夹名都可以搜。'
)

function close() {
  emit('close')
}

function reset() {
  cancelSearch()
  keyword.value = ''
  folders.value = []
  files.value = []
  searching.value = false
  searched.value = false
  truncated.value = false
}

function clearKeyword() {
  keyword.value = ''
  reset()
  inputRef.value?.focus()
}

function onInput() {
  cancelSearch()
  const q = keyword.value.trim()
  if (!q) {
    folders.value = []
    files.value = []
    searching.value = false
    searched.value = false
    truncated.value = false
    return
  }
  searching.value = true
  scheduleSearch(q)
}

/** 最近一次调用的序号。在飞的回调拿它跟自己手里的 id 比，对不上就放弃写状态 */
const latest = () => latestSeq()

// runSearch 由 useDebounced 调度；id 是本次调用的序号
async function runSearch(q: string, id: number) {
  try {
    const res = await SearchService.search(q, props.scope)
    // 后到的旧请求直接丢弃：它的关键词已经不是输入框里那个了
    if (id !== latest()) return
    folders.value = res.folders ?? []
    files.value = res.files ?? []
    truncated.value = !!res.truncated
    if (res.limit) resultLimit.value = res.limit
  } catch {
    if (id !== latest()) return
    folders.value = []
    files.value = []
    truncated.value = false
  } finally {
    if (id === latest()) {
      searching.value = false
      searched.value = true
    }
  }
}

function onPickFolder(folder: FileListFolder) {
  const hit = folder as unknown as SearchFolderHit
  emit('pick', { ownerId: Number(hit.ownerId), path: hit.path ?? [] })
}

function onPickFile(file: FileListFile) {
  const hit = file as unknown as SearchFileHit
  emit('pick', { ownerId: Number(hit.ownerId), path: hit.path ?? [], file: hit })
}

/** 「到所在文件夹」：和点目录一样是纯跳转，不带预览 */
function onLocateFile(file: FileListFile) {
  const hit = file as unknown as SearchFileHit
  emit('pick', { ownerId: Number(hit.ownerId), path: hit.path ?? [] })
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset()
      // 打开就聚焦：这个弹窗的唯一动作就是打字
      void nextTick(() => inputRef.value?.focus())
    } else {
      reset()
    }
  }
)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) close()
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
  })
}
</script>

<style scoped>
/*
  与 .share-modal 同一套参数（ShareDialog.vue 末尾那段），改名是为了
  两个弹窗能各自演进而不互相牵连。手感保持一致：移动端从下滑入、
  桌面端轻微缩放。
*/
.search-modal-enter-active,
.search-modal-leave-active {
  transition: opacity 0.18s ease;
}
.search-modal-enter-active > div:last-child,
.search-modal-leave-active > div:last-child {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.search-modal-enter-from,
.search-modal-leave-to {
  opacity: 0;
}
.search-modal-enter-from > div:last-child,
.search-modal-leave-to > div:last-child {
  transform: translateY(16px);
}
@media (min-width: 640px) {
  .search-modal-enter-from > div:last-child,
  .search-modal-leave-to > div:last-child {
    transform: scale(0.97);
  }
}
</style>
