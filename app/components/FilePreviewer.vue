<template>
  <!-- 全屏预览不做边缘折射：占满视口时看不到「边缘」，只留 CSS 的磨砂底 -->
  <div class="fixed inset-0 z-50 flex flex-col bg-white">
    <div class="flex items-center justify-between border-b px-4 py-3">
      <div class="min-w-0">
        <p class="text-xs text-gray-500">{{ zipEntry ? '压缩包内文件预览' : '文件预览' }}</p>
        <h3 class="truncate text-base font-medium text-gray-900 sm:text-lg">{{ zipEntry?.filename || file?.filename }}</h3>
      </div>
      <div class="flex items-center gap-2">
        <!--
          预览器选择。永远列出全部预览器，不按当前文件类型过滤 —— 认不出扩展名
          和「这个文件真不是那种东西」在界面上长得一样，把判断权交出去更诚实。

          压缩包内页不显示：那时顶栏指的是压缩包里的那个文件，换外层文件的预览器
          会把当前视图直接冲掉。
        -->
        <div v-if="!zipEntry" class="flex items-center gap-1.5">
          <EyeIcon class="hidden h-4 w-4 shrink-0 text-gray-400 sm:block" />
          <select
            :value="activePreviewer ?? ''"
            title="选择预览器"
            aria-label="选择预览器"
            class="rounded-md border border-gray-200 bg-white py-1.5 pl-2 pr-6 text-xs text-gray-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            @change="pickPreviewer"
          >
            <option value="" disabled>选择预览器</option>
            <option v-for="p in PREVIEWERS" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
        </div>

        <!--
          链接视角只读：保存 / 替换文件两个入口都不给。
          服务端本来也拦（/api/upload/credentials 与 /api/files/save 没有 link 分支），
          但给一个点了必失败的按钮不如不给。
        -->
        <button
          v-if="isEditable && !zipEntry && !linkMode"
          class="rounded-md bg-indigo-600 p-2 text-white hover:bg-indigo-700 disabled:opacity-50"
          title="保存"
          aria-label="保存"
          :disabled="!dirty || uploading"
          @click="saveText"
        >
          <svg v-if="uploading" class="h-5 w-5 animate-spin" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <CheckIcon v-else class="h-5 w-5" />
        </button>

        <button
          v-if="!zipEntry && !linkMode"
          class="rounded-md border border-indigo-200 p-2 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
          title="替换文件"
          aria-label="替换文件"
          :disabled="uploading"
          @click="replaceInputRef?.click()"
        >
          <ArrowUpTrayIcon class="h-5 w-5" />
        </button>
        <input ref="replaceInputRef" type="file" class="hidden" @change="handlePickReplacement" />

        <button
          v-if="zipEntry"
          class="rounded-md border border-gray-200 p-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          title="下载当前文件"
          aria-label="下载当前文件"
          :disabled="zipEntryLoading"
          @click="downloadZipEntry"
        >
          <ArrowDownTrayIcon class="h-5 w-5" />
        </button>
        <button
          v-else
          class="rounded-md border border-gray-200 p-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          title="下载"
          aria-label="下载"
          :disabled="loading"
          @click="handleDownload"
        >
          <ArrowDownTrayIcon class="h-5 w-5" />
        </button>

        <button class="rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900" title="关闭" aria-label="关闭" @click="handleClose">
          <XMarkIcon class="h-6 w-6" />
        </button>
      </div>
    </div>

    <div v-if="uploading" class="px-4 py-2">
      <div class="mb-2 flex items-center justify-between text-sm text-gray-600">
        <span>上传中...</span>
        <span>{{ uploadProgress.percent }}%</span>
      </div>
      <div class="h-2 w-full rounded-full bg-gray-200">
        <div class="h-2 rounded-full bg-indigo-600 transition-all duration-300" :style="{ width: `${uploadProgress.percent}%` }" />
      </div>
    </div>

    <div v-if="error" class="mx-4 my-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ error }}
    </div>

    <div class="min-h-0 flex-1">
      <div v-if="loading" class="flex h-full items-center justify-center text-gray-600">
        <div class="inline-flex items-center">
          <svg class="mr-3 h-5 w-5 -ml-1 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          加载中...
        </div>
      </div>

      <div v-else-if="activePreviewer === 'zip' || activePreviewer === '7z'" class="h-full min-h-0">
        <ZipPreview
          v-if="archiveBlob && activePreviewer === 'zip'"
          v-show="!zipEntry"
          :archive="archiveBlob"
          :archive-name="file.filename"
          @open-entry="openZipEntry"
        />
        <SevenZipPreview
          v-if="archiveBlob && activePreviewer === '7z'"
          v-show="!zipEntry"
          :archive="archiveBlob"
          :archive-name="file.filename"
          @open-entry="openZipEntry"
        />
        <div v-if="zipEntry" class="flex h-full min-h-0 flex-col">
          <div class="flex items-center gap-3 border-b bg-white px-4 py-2">
            <button class="rounded-md border border-gray-200 p-1.5 text-gray-700 hover:bg-gray-50" title="返回压缩包" aria-label="返回压缩包" @click="backToArchive">
              <ArrowLeftIcon class="h-4 w-4" />
            </button>
            <span class="truncate text-xs text-gray-500">{{ zipEntry.path }} · {{ formatFileSize(zipEntry.fileSize) }}<span v-if="zipEntry.encrypted"> · 已加密</span></span>
          </div>
          <div v-if="zipEntryLoading" class="flex h-full items-center justify-center text-gray-600">
            <div class="inline-flex items-center">
              <svg class="mr-3 h-5 w-5 -ml-1 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              解压中...
            </div>
          </div>
          <div v-else-if="zipEntryError" class="flex h-full items-center justify-center px-4 text-center text-sm text-red-700">{{ zipEntryError }}</div>
          <div v-else-if="isZipEntryImage && zipEntryBlobUrl" class="h-full w-full overflow-auto bg-gray-50 p-4">
            <img :src="zipEntryBlobUrl" class="mx-auto max-h-full max-w-full object-contain" alt="预览" />
          </div>
          <div v-else-if="isZipEntryVideo && zipEntryBlobUrl" class="flex h-full w-full items-center justify-center bg-black">
            <video :src="zipEntryBlobUrl" class="max-h-full max-w-full" controls playsinline preload="metadata" />
          </div>
          <div v-else-if="isZipEntryAudio && zipEntryBlobUrl" class="flex h-full items-center justify-center bg-gray-50 p-6">
            <audio :src="zipEntryBlobUrl" class="w-full max-w-xl" controls preload="metadata" />
          </div>
          <div v-else-if="isZipEntryPdf && zipEntryBlobUrl" class="h-full w-full bg-gray-50">
            <iframe :src="zipEntryBlobUrl" class="h-full w-full" title="PDF 预览" />
          </div>
          <div v-else-if="isZipEntryText" class="flex h-full min-h-0 flex-col">
            <textarea :value="zipEntryText" class="min-h-0 flex-1 w-full resize-none p-3 font-mono text-sm outline-none sm:p-4" readonly />
          </div>
          <div v-else class="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500">
            该文件类型暂不支持在线预览，可下载后查看。
          </div>
        </div>
        <div v-if="!archiveBlob" class="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500">
          无法加载压缩包内容。
        </div>
      </div>

      <div v-else-if="activePreviewer === null" class="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500">
        请选择预览器
      </div>

      <div v-else-if="activePreviewer === 'none'" class="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500">
        已选择不预览，可直接下载
      </div>

      <div v-else-if="activePreviewer === 'image'" class="h-full w-full overflow-auto bg-gray-50 flex items-center justify-center">
        <img v-if="blobUrl" :src="blobUrl" class="max-h-full max-w-full object-contain" referrerpolicy="no-referrer" alt="预览" />
      </div>

      <div v-else-if="activePreviewer === 'video'" class="flex h-full w-full items-center justify-center bg-black">
        <video
          v-if="blobUrl"
          :src="blobUrl"
          class="max-h-full max-w-full"
          controls
          playsinline
          preload="metadata"
        />
        <div v-else class="text-sm text-gray-400">无法加载视频预览</div>
      </div>

      <div v-else-if="activePreviewer === 'audio'" class="flex h-full w-full flex-col items-center justify-center gap-4 bg-gray-50 p-6">
        <audio
          v-if="blobUrl"
          :src="blobUrl"
          class="w-full max-w-xl"
          controls
          preload="metadata"
        />
        <div v-else class="text-sm text-gray-500">无法加载音频预览</div>
      </div>

      <div v-else-if="activePreviewer === 'pdf'" class="h-full w-full bg-gray-50">
        <iframe v-if="blobUrl" :src="blobUrl" class="h-full w-full" title="PDF 预览" />
        <div v-else class="flex h-full items-center justify-center text-gray-500">无法加载 PDF 预览</div>
      </div>

      <!--
        文本 / 代码预览：可不可编辑只看视角，不看扩展名。
        用户把 .png 强行丢进预览器时也给编辑 —— 那是他自己选的，按当前编码
        写回。分享链接仍然是只读：保存走的是上传接口，没有 link 分支，给了按钮
        也只能失败。

        代码只是同一份文本换了个渲染器：解码、编码、保存、大小全都共用，所以
        两种模式挤在一个分支里 —— 编码下拉、未保存提示只有一份。
      -->
      <div v-else-if="activePreviewer === 'text' || activePreviewer === 'code'" class="flex h-full flex-col">
        <div class="flex items-center justify-between gap-2 border-b px-4 py-2 text-xs text-gray-500">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="truncate">{{ previewerLabel }} · 大小 {{ prettySize }}</span>
            <!--
              编码选择。GBK 的 .txt 按 UTF-8 解就是满屏「�」，只能靠这里换。
              换编码只是重新解同一份字节（缓存层已有一份），不重新下载。
              有未保存修改时先问一句：重新解码会把它们冲掉。
            -->
            <select
              :value="encoding"
              title="选择编码"
              aria-label="选择编码"
              :disabled="loading"
              class="shrink-0 rounded border border-gray-200 bg-white py-0.5 pl-1.5 pr-5 text-xs text-gray-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:opacity-50"
              @change="pickEncoding"
            >
              <option v-for="e in TEXT_ENCODINGS" :key="e.id" :value="e.id">{{ e.label }}</option>
            </select>
            <!--
              语言选择。扩展名认不出来（.txt 里放代码、新建的无扩展名文件）时，
              自动会落到纯文本 —— 这里让用户直接指定。默认 auto，换文件重置，
              和「预览器/编码只对当前文件有效」同一口径。
            -->
            <select
              v-if="activePreviewer === 'code'"
              :value="codeLanguageChoice"
              title="选择语言"
              aria-label="选择语言"
              class="shrink-0 rounded border border-gray-200 bg-white py-0.5 pl-1.5 pr-5 text-xs text-gray-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              @change="pickCodeLanguage"
            >
              <option value="auto">自动（{{ languageLabel(autoCodeLanguage) }}）</option>
              <option v-for="l in CODE_LANGUAGES" :key="l.id" :value="l.id">{{ l.label }}</option>
            </select>
            <!--
              主题选择只属于代码预览。存的是「选择」（auto / light / dark），
              不是解析后的明暗 —— 存死明暗的话，用户切了系统主题后已经打开的
              预览器不会跟。解析在 resolvedCodeTheme 里做。
            -->
            <select
              v-if="activePreviewer === 'code'"
              :value="codeTheme"
              title="选择主题"
              aria-label="选择主题"
              class="shrink-0 rounded border border-gray-200 bg-white py-0.5 pl-1.5 pr-5 text-xs text-gray-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              @change="pickCodeTheme"
            >
              <option v-for="t in CODE_THEMES" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </div>
          <span v-if="linkMode" class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">分享链接 · 只读</span>
        </div>
        <CodeTextEditor
          v-if="activePreviewer === 'code'"
          v-model="textContent"
          :language="codeLanguage"
          :theme="resolvedCodeTheme"
          :readonly="!isEditable"
          class="min-h-0 flex-1"
        />
        <textarea v-else-if="isEditable" v-model="textContent" :placeholder="EMPTY_TEXT_PLACEHOLDER" class="flex-1 w-full p-3 font-mono text-sm outline-none sm:p-4" />
        <pre v-else class="flex-1 w-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-sm outline-none sm:p-4">{{ textContent }}</pre>
        <div v-if="tooLargeHint" class="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">{{ tooLargeHint }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toRef, watch } from 'vue'
import { ArrowDownTrayIcon, ArrowLeftIcon, ArrowUpTrayIcon, CheckIcon, EyeIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import ZipPreview from '~/components/ZipPreview.vue'
import SevenZipPreview from '~/components/SevenZipPreview.vue'
import CodeTextEditor from '~/components/CodeTextEditor.vue'
import { FilesService } from '~/services/files.service'
import { useFileUpload } from '~/composables/useFileUpload'
import { openPrompt } from '~/composables/usePromptDialog'
import { formatFileSize } from '~/utils/format'
import { notify } from '~/utils/notify'
import {
  PREVIEWERS,
  EMPTY_TEXT_PLACEHOLDER,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  TEXT_EXTENSIONS,
  extensionOf,
  resolvePreviewer,
  isPreviewerId,
  type PreviewerId
} from '~/utils/previewer'
import { mimeFor, withMimeType } from '~/utils/mime'
import {
  TEXT_ENCODINGS,
  DEFAULT_TEXT_ENCODING,
  decodeText,
  encodeText,
  isTextEncodingId,
  type TextEncodingId
} from '~/utils/text-encoding'
import {
  CODE_THEMES,
  isCodeTheme,
  readCodeTheme,
  resolveCodeTheme,
  writeCodeTheme,
  type CodeThemeId,
  type ResolvedCodeTheme
} from '~/utils/code-theme'
import {
  CODE_LANGUAGES,
  isCodeLanguageId,
  languageForFilename,
  languageLabel,
  resolveCodeLanguage,
  type CodeLanguageChoice
} from '~/utils/code-language'
import { createPreviewSource } from '~/utils/preview-source'
import type { FileRecord } from '~~/types/files'
import type { ArchiveFileItem } from '~~/types/zip'
import { NO_DOWNLOAD_MESSAGE } from '~~/types/share'

const props = defineProps<{
  file: FileRecord
  targetUserId?: number | null
  /**
   * 分享链接 token。加载和下载都要带上 —— 预览走的就是 /api/files/download，
   * 少了 link 的话匿名访客点开一个文件就是 401。
   */
  link?: string | null
  /**
   * 管理视角：/manage/files 里管理员替别人看文件。
   *
   * **必须显式传**，不能靠 targetUserId 推断 —— 首页的分享视角同样有
   * targetUserId，但那不是管理权限，带上会被服务端 403。与 FileBrowser
   * 的 useAdmin 是同一个值。
   *
   * 不传的话下载/保存都会被服务端当成「我以自己身份操作别人的文件」：
   * 预览直接 404，保存会写错身份。
   */
  useAdmin?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()
const targetUserIdRef = toRef(props, 'targetUserId')
const useAdminRef = toRef(props, 'useAdmin')
const currentFileKey = ref(props.file.fileKey)
const replaceInputRef = ref<HTMLInputElement | null>(null)
/**
 * 取 localStorage。读和写都可能抛（Safari 隐私模式、配额写满），
 * 在这里一次性兜住；取不到就当没存过，不能让预览器不可用。
 */
const getLocalStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
/** 用户在当前文件上手动选过的预览器。null = 用默认（按扩展名判定）。 */
const chosenPreviewer = ref<PreviewerId | null>(null)
/** 文本按哪种编码解、按哪种编码写回。只对当前文件有效，换文件重置。 */
const encoding = ref<TextEncodingId>(DEFAULT_TEXT_ENCODING)
/**
 * 代码预览的配色。这是**用户偏好**，不是文件属性，所以跨文件记住；
 * 换文件时不重置（与 chosenPreviewer / encoding 的口径相反）。
 */
const codeTheme = ref<CodeThemeId>(readCodeTheme(getLocalStorage()))
/**
 * 代码预览的语法。auto = 按扩展名；显式选择只对当前文件有效 ——
 * 和 chosenPreviewer / encoding 一样，换文件重置。
 */
const codeLanguageChoice = ref<CodeLanguageChoice>('auto')
const systemDarkQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null
const prefersDark = ref(!!systemDarkQuery?.matches)
const loading = ref(false)
const error = ref('')
const textContent = ref('')
const originalContent = ref('')
const blobUrl = ref('')
const archiveBlob = shallowRef<Blob | null>(null)
const zipEntry = shallowRef<ArchiveFileItem | null>(null)
const zipEntryLoading = ref(false)
const zipEntryError = ref('')
const zipEntryBlobUrl = ref('')
const zipEntryText = ref('')
const zipEntryPassword = ref('')
const zipEntryController = ref<AbortController | null>(null)
const MAX_ENTRY_SIZE = 100 * 1024 * 1024
let renderId = 0
let loadId = 0

const { uploading, uploadProgress, uploadFile } = useFileUpload({ targetUserId: targetUserIdRef, useAdmin: useAdminRef })

/**
 * 预览字节的缓存。切换预览器时字节是同一份，不该重新下载 —— 由这一层记住它。
 *
 * 组件这边只通过 source.get() 取字节，没有第二条下载路径；否则缓存会被绕过，
 * 而界面上看不出区别（只是一次大文件不知不觉传了两遍）。
 */
const source = createPreviewSource({
  sign: async (fileKey) => {
    const sign = await FilesService.downloadSign(
      { fileKey, filename: props.file.filename },
      props.targetUserId ?? null,
      props.useAdmin,
      props.link ?? null
    )
    if (!sign.success) throw new Error('获取下载链接失败')
    return sign.data.downloadUrl
  },
  fetchBlob: async (url, signal) => {
    const response = await fetch(url, { method: 'GET', signal })
    if (!response.ok) throw new Error('拉取文件内容失败')
    return response.blob()
  }
})

const ext = computed(() => extensionOf(props.file?.filename ?? ''))
/** 当前实际使用：用户选过的优先，否则按扩展名。 */
const activePreviewer = computed(() => resolvePreviewer(props.file?.filename ?? '', chosenPreviewer.value))
const isMd = computed(() => ext.value === 'md' || ext.value === 'markdown')
/** 头部那行字：代码预览不显示「纯文本」，否则用户会以为自己选错了预览器。 */
const previewerLabel = computed(() => {
  if (activePreviewer.value === 'code') return '代码'
  return isMd.value ? 'Markdown' : '纯文本'
})
const autoCodeLanguage = computed(() => languageForFilename(props.file?.filename ?? ''))
const codeLanguage = computed(() => resolveCodeLanguage(props.file?.filename ?? '', codeLanguageChoice.value))
const resolvedCodeTheme = computed<ResolvedCodeTheme>(() => resolveCodeTheme(codeTheme.value, prefersDark.value))
/**
 * 链接视角。链接只给读+下载，所以「可编辑」在这里必须为 false ——
 * 否则会渲染出文本编辑框和保存按钮，而保存走的是上传接口（没有 link 分支）。
 *
 * 除此之外**只要求当前预览器是文本或代码**，不再要求扩展名本身是文本。
 * 原来还卡了一层「扩展名是文本才给编辑」，结果是：没有扩展名的新建文件、
 * .js/.ts/.py 这些，点开文本预览只能看不能改。用户既然已经手动选中了文本
 * 预览器，编辑权就该给他 —— 把 .png 当文本改再保存是他自己的选择。
 */
const linkMode = computed(() => !!props.link)
const isEditable = computed(() => !linkMode.value && (activePreviewer.value === 'text' || activePreviewer.value === 'code'))
const isZipEntryImage = computed(() => !!zipEntry.value && isImageName(zipEntry.value.filename))
const isZipEntryVideo = computed(() => !!zipEntry.value && isVideoName(zipEntry.value.filename))
const isZipEntryAudio = computed(() => !!zipEntry.value && isAudioName(zipEntry.value.filename))
const isZipEntryPdf = computed(() => !!zipEntry.value && extensionOf(zipEntry.value.filename) === 'pdf')
const isZipEntryText = computed(() => !!zipEntry.value && isTextName(zipEntry.value.filename) && zipEntry.value.fileSize <= 10 * 1024 * 1024)
const currentFileSize = computed(() => {
  if (zipEntry.value) return zipEntry.value.fileSize
  // 边打字边算大小只在 UTF-8 下做：TextEncoder 是现成的。其他编码要先建反查表
  // 再逐字查，放进每次按键都会重算的 computed 里不合适，就退回磁盘上的大小。
  if (isEditable.value && encoding.value === 'utf-8') return new TextEncoder().encode(textContent.value).length
  return props.file.fileSize
})
const dirty = computed(() => isEditable.value && textContent.value !== originalContent.value)
const prettySize = computed(() => formatFileSize(Math.max(0, Number(currentFileSize.value) || 0)))
const tooLargeHint = computed(() => {
  if (!isEditable.value || props.file.fileSize <= 5 * 1024 * 1024) return ''
  return '提示：文件较大（>5MB），在浏览器中编辑可能会较慢。'
})

/**
 * 压缩包内文件的判定复用同一批扩展名表 —— 原来这里和顶部各抄了一份，
 * 改一处漏一处就会让压缩包里预览得了、外面预览不了。
 */
const isImageName = (filename: string) => IMAGE_EXTENSIONS.has(extensionOf(filename))
const isVideoName = (filename: string) => VIDEO_EXTENSIONS.has(extensionOf(filename))
const isAudioName = (filename: string) => AUDIO_EXTENSIONS.has(extensionOf(filename))
const isTextName = (filename: string) => TEXT_EXTENSIONS.has(extensionOf(filename))

const revokeUrl = (url: string) => {
  if (url) URL.revokeObjectURL(url)
}
const revokeBlob = () => {
  revokeUrl(blobUrl.value)
  blobUrl.value = ''
}
const cleanupZipEntry = () => {
  zipEntryController.value?.abort()
  zipEntryController.value = null
  zipEntryLoading.value = false
  zipEntryError.value = ''
  zipEntryText.value = ''
  zipEntryPassword.value = ''
  revokeUrl(zipEntryBlobUrl.value)
  zipEntryBlobUrl.value = ''
  zipEntry.value = null
}
const cleanup = () => {
  loadId += 1
  source.invalidate()
  cleanupZipEntry()
  revokeBlob()
  archiveBlob.value = null
}

/**
 * 把已拿到的字节铺到当前预览器上。**不发请求** —— 切换预览器走的就是这条路。
 *
 * renderId 兜住一个竞态：文本分支要 await arrayBuffer()，这期间用户可能又切了
 * 预览器或换了编码。没有它，先发起的那次会在新视图上贴一段旧文本。
 *
 * 文本按**当前选中的编码**解，不是 Blob.text() 的固定 UTF-8 —— 换编码时走的
 * 也是这里，字节还是缓存里那一份，不重新下载。
 */
const renderPreview = async (blob: Blob | null) => {
  const id = ++renderId
  revokeBlob()
  archiveBlob.value = null
  textContent.value = ''
  originalContent.value = ''
  if (!blob) return

  const target = activePreviewer.value
  if (target === 'text' || target === 'code') {
    const text = decodeText(new Uint8Array(await blob.arrayBuffer()), encoding.value)
    if (id !== renderId) return
    originalContent.value = text
    textContent.value = text
  } else if (target === 'image' || target === 'pdf') {
    blobUrl.value = URL.createObjectURL(blob)
  } else if (target === 'video' || target === 'audio') {
    blobUrl.value = URL.createObjectURL(withMimeType(blob, props.file?.filename ?? ''))
  } else if (target === 'zip' || target === '7z') {
    archiveBlob.value = blob
  }
}

const load = async () => {
  const requestId = ++loadId
  cleanupZipEntry()
  // 已经有这个文件的字节就不显示转圈：切换预览器不该看起来像在重新加载。
  if (source.cachedKey() !== currentFileKey.value) loading.value = true
  error.value = ''
  renderId += 1
  revokeBlob()
  archiveBlob.value = null
  textContent.value = ''
  originalContent.value = ''
  try {
    // 服务端不给没有下载位的人 fileKey（真实对象路径）。预览走的就是
    // /api/files/download，没有它必然 400 —— 直接说清原因。
    if (!currentFileKey.value) throw new Error(NO_DOWNLOAD_MESSAGE)

    const target = activePreviewer.value
    /**
     * 没有选定的预览器（类型认不出来、用户还没选），或者用户选了不预览：
     * 连签名请求都不该发，更不该把整个文件拉下来再丢掉。
     *
     * 原来对不支持的扩展名是走完整条链路的 —— 签名、fetch、读完响应体，
     * 然后三个分支一个都不匹配，字节白下载一遍。打开一个 .exe 就是这么
     * 把几百 MB 流量烧掉的。
     */
    if (target === null || target === 'none') return

    // 命中的就是这里：同一个文件第二次要字节时不签名、不请求。
    const blob = await source.get(currentFileKey.value)
    if (requestId !== loadId) return
    await renderPreview(blob)
  } catch (e: any) {
    if (requestId === loadId && e?.name !== 'AbortError') error.value = e?.message || '加载失败'
  } finally {
    if (requestId === loadId) loading.value = false
  }
}

/**
 * 问压缩包密码。
 *
 * **不回显**：原来是 `window.prompt`，密码直接画在屏幕上 —— 肩窥、录屏、截图，
 * 以及系统弹窗自己那条历史记录。
 *
 * **不 trim**：压缩包密码里的首尾空格是密码的一部分，trim 掉会让用户输对了
 * 却解不开，而且没有任何提示（「密码错误」会让人怀疑自己记错了）。
 *
 * 空值当「没填」而不是「空密码」：这个文件既然标记为已加密，空密码必然解不开，
 * 与其白跑一次解密再报错，不如在输入框下面说清「不能为空」。
 */
const getZipPassword = async (): Promise<string | null> => {
  if (!zipEntry.value?.encrypted) return ''
  return await openPrompt({
    title: '该文件已加密',
    label: '压缩包密码',
    hint: '解压需要这个压缩包的密码。它只用于本次预览，不会被保存。',
    placeholder: '请输入密码',
    confirmText: '解压',
    secret: true,
    trim: false
  })
}

const openZipEntry = async (item: ArchiveFileItem) => {
  cleanupZipEntry()
  zipEntry.value = item
  if (typeof window !== 'undefined' && item.encrypted) {
    const password = await getZipPassword()
    if (password === null) {
      // 取消：退出预览，别留一个打不开的条目在界面上
      zipEntry.value = null
      return
    }
    zipEntryPassword.value = password
  }
  await extractZipEntry(item)
}

const extractZipEntry = async (item: ArchiveFileItem) => {
  zipEntryError.value = ''
  revokeUrl(zipEntryBlobUrl.value)
  zipEntryBlobUrl.value = ''
  zipEntryText.value = ''
  if (item.fileSize > MAX_ENTRY_SIZE) {
    zipEntryError.value = '文件解压后超过 100 MB，已阻止在线预览，请下载后查看。'
    return
  }
  zipEntryLoading.value = true
  const controller = new AbortController()
  zipEntryController.value = controller
  try {
    const extracted = await item.read({
      password: item.encrypted ? zipEntryPassword.value : undefined,
      signal: controller.signal
    })
    const blob = new Blob([extracted], { type: mimeFor(item.filename) })
    if (isZipEntryText.value) zipEntryText.value = await blob.text()
    else zipEntryBlobUrl.value = URL.createObjectURL(blob)
  } catch (e: any) {
    if (!controller.signal.aborted) zipEntryError.value = e?.message || '解压文件失败'
  } finally {
    if (zipEntryController.value === controller) {
      zipEntryController.value = null
      zipEntryLoading.value = false
    }
  }
}

const backToArchive = () => {
  cleanupZipEntry()
}

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const downloadZipEntry = async () => {
  const item = zipEntry.value
  if (!item || zipEntryLoading.value) return
  if (item.fileSize > MAX_ENTRY_SIZE) {
    zipEntryError.value = '文件解压后超过 100 MB，已阻止在线下载，请使用压缩包下载功能。'
    return
  }
  try {
    if (zipEntryBlobUrl.value) {
      const link = document.createElement('a')
      link.href = zipEntryBlobUrl.value
      link.download = item.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      return
    }
    if (isZipEntryText.value) {
      triggerDownload(new Blob([zipEntryText.value], { type: 'text/plain' }), item.filename)
      return
    }
    const password = item.encrypted ? getZipPassword() : ''
    if (password === null) return
    const extracted = await item.read({ password })
    triggerDownload(new Blob([extracted], { type: mimeFor(item.filename) }), item.filename)
  } catch (e: any) {
    zipEntryError.value = e?.message || '下载文件失败'
  }
}

const saveText = async () => {
  if (!isEditable.value || !dirty.value) return
  try {
    error.value = ''
    const type = isMd.value ? 'text/markdown' : 'text/plain'
    // 用选中的编码写回，不是固定 UTF-8 —— 否则「按 GBK 看」再保存一下，
    // 磁盘上的文件就被悄悄转成 UTF-8 了。写不下的字会抛，错误挂在 error 上。
    const bytes = encodeText(textContent.value, encoding.value)
    const blob = new Blob([bytes], { type })
    const newFile = new File([blob], props.file.filename, { type })
    currentFileKey.value = await uploadFile(newFile, {
      // 写回**文件自己的**目录，不是当前浏览的目录 ——
      // 从搜索结果直接打开时两者不同（人在 A 目录，文件在 B 目录），
      // 用当前目录会把替换内容上传到 A 去。
      folderId: props.file.folderId ?? null,
      overwrite: true
    })
    originalContent.value = textContent.value
    emit('saved')
    notify('保存成功', 'success')
  } catch (e: any) {
    error.value = e?.message || '保存失败'
  }
}

const handlePickReplacement = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const selected = input.files?.[0]
  input.value = ''
  if (!selected) return
  try {
    error.value = ''
    const replacement = new File([selected], props.file.filename, { type: selected.type || 'application/octet-stream' })
    currentFileKey.value = await uploadFile(replacement, {
      // 同上：写回文件自己的目录
      folderId: props.file.folderId ?? null,
      overwrite: true
    })
    await load()
    emit('saved')
    notify('替换成功', 'success')
  } catch (err: any) {
    error.value = err?.message || '替换失败'
  }
}

const handleDownload = async () => {
  try {
    if (!currentFileKey.value) throw new Error(NO_DOWNLOAD_MESSAGE)
    const sign = await FilesService.downloadSign(
      { fileKey: currentFileKey.value, filename: props.file.filename },
      props.targetUserId ?? null,
      props.useAdmin,
      props.link ?? null
    )
    if (!sign.success) throw new Error('获取下载链接失败')
    const response = await fetch(sign.data.downloadUrl)
    if (!response.ok) throw new Error('下载失败')
    triggerDownload(await response.blob(), props.file.filename)
  } catch (e: any) {
    error.value = e?.message || '下载失败'
  }
}

const handleClose = () => emit('close')

/**
 * 换预览器。选择只对当前文件有效 —— 记住会让「类型认得出来就用默认」失效：
 * 上一个文件被强行指定成图片之后，下一个 .md 也会是图片。
 */
const pickPreviewer = (event: Event) => {
  const raw = (event.target as HTMLSelectElement).value
  const next = isPreviewerId(raw) ? raw : null
  const before = activePreviewer.value
  chosenPreviewer.value = next
  // 解析结果没变（比如对 .png 重选图片）就不必重新拉一遍内容。
  if (activePreviewer.value !== before) void load()
}

/**
 * 换编码：重新解**缓存里那份字节**，不重新下载（load() 取数走的是
 * preview-source，同 key 直接命中）。
 *
 * 有未保存的修改时先问一句。重新解码会把编辑框里的内容整个替换掉，
 * 而那可能是用户打了半天的一段话 —— 这里不能默认他愿意丢。
 * 取消时要把 select 的值拨回去：它现在是 DOM 自己改的，状态没变，
 * Vue 不会重渲染这个元素。
 */
const pickEncoding = (event: Event) => {
  const select = event.target as HTMLSelectElement
  const raw = select.value
  if (!isTextEncodingId(raw) || raw === encoding.value) return
  if (dirty.value && !confirm('切换编码会丢掉未保存的修改，继续？')) {
    select.value = encoding.value
    return
  }
  encoding.value = raw
  void load()
}

/**
 * 系统深浅变化只对 auto 有效；显式选了浅/深时 resolveCodeTheme 会忽略它。
 * matchMedia 的监听要在卸载时摘掉，否则关掉预览器之后它还在改一个已销毁的 ref。
 */
const syncSystemTheme = (event?: MediaQueryListEvent) => {
  prefersDark.value = event ? event.matches : !!systemDarkQuery?.matches
}

onMounted(() => {
  if (!systemDarkQuery) return
  systemDarkQuery.addEventListener('change', syncSystemTheme)
  prefersDark.value = systemDarkQuery.matches
})

onBeforeUnmount(() => {
  systemDarkQuery?.removeEventListener('change', syncSystemTheme)
})

/**
 * 换主题只影响代码区，不动页面。选择存 localStorage —— 这是用户偏好，
 * 不该每开一个文件就回到跟随系统。
 */
const pickCodeTheme = (event: Event) => {
  const raw = (event.target as HTMLSelectElement).value
  if (!isCodeTheme(raw) || raw === codeTheme.value) return
  codeTheme.value = raw
  writeCodeTheme(getLocalStorage(), raw)
}

/**
 * 换语言只换语法高亮，不碰文本内容 —— 所以不需要 confirm。
 */
const pickCodeLanguage = (event: Event) => {
  const raw = (event.target as HTMLSelectElement).value
  if (raw === 'auto') {
    codeLanguageChoice.value = 'auto'
    return
  }
  if (isCodeLanguageId(raw)) codeLanguageChoice.value = raw
}

watch(() => props.file?.id, (id) => {
  if (id === undefined) return
  currentFileKey.value = props.file.fileKey
  chosenPreviewer.value = null
  encoding.value = DEFAULT_TEXT_ENCODING
  codeLanguageChoice.value = 'auto'
  void load()
}, { immediate: true })

watch(() => props.file?.fileKey, (key) => {
  if (key) currentFileKey.value = key
})

onBeforeUnmount(() => cleanup())
</script>
