<template>
  <div data-liquid class="fixed inset-0 z-50 flex flex-col bg-white">
    <div class="flex items-center justify-between border-b px-4 py-3">
      <div class="min-w-0">
        <p class="text-xs text-gray-500">{{ zipEntry ? '压缩包内文件预览' : '文件预览' }}</p>
        <h3 class="truncate text-base font-medium text-gray-900 sm:text-lg">{{ zipEntry?.filename || file?.filename }}</h3>
      </div>
      <div class="flex items-center gap-2">
        <!--
          链接视角只读：保存 / 替换文件两个入口都不给。
          服务端本来也拦（/api/upload/credentials 与 /api/files/save 没有 link 分支），
          但给一个点了必失败的按钮不如不给。
        -->
        <button
          v-if="isEditable && !zipEntry && !linkMode"
          class="rounded-md bg-indigo-600 px-3 py-2 text-white hover:bg-indigo-700 disabled:opacity-50"
          :disabled="!dirty || uploading"
          @click="saveText"
        >
          <span v-if="!uploading">保存</span>
          <span v-else class="inline-flex items-center">
            <svg class="mr-1 h-4 w-4 animate-spin" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            保存中
          </span>
        </button>

        <button
          v-if="!zipEntry && !linkMode"
          class="rounded-md border border-indigo-200 px-3 py-2 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
          :disabled="uploading"
          @click="replaceInputRef?.click()"
        >
          替换文件
        </button>
        <input ref="replaceInputRef" type="file" class="hidden" @change="handlePickReplacement" />

        <button
          v-if="zipEntry"
          class="rounded-md border border-gray-200 px-3 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          :disabled="zipEntryLoading"
          @click="downloadZipEntry"
        >
          下载当前文件
        </button>
        <button
          v-else
          class="rounded-md border border-gray-200 px-3 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          :disabled="loading"
          @click="handleDownload"
        >
          下载
        </button>

        <button class="p-2 text-gray-600 hover:text-gray-800" @click="handleClose" aria-label="关闭">
          <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none">
            <path d="M6 18L18 6M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
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

      <div v-else-if="isArchive" class="h-full min-h-0">
        <ZipPreview
          v-if="archiveBlob && archiveFormat === 'zip'"
          v-show="!zipEntry"
          :archive="archiveBlob"
          :archive-name="file.filename"
          @open-entry="openZipEntry"
        />
        <SevenZipPreview
          v-if="archiveBlob && archiveFormat !== 'zip'"
          v-show="!zipEntry"
          :archive="archiveBlob"
          :archive-name="file.filename"
          @open-entry="openZipEntry"
        />
        <div v-if="zipEntry" class="flex h-full min-h-0 flex-col">
          <div class="flex items-center gap-3 border-b bg-white px-4 py-2">
            <button class="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50" @click="backToArchive">
              返回压缩包
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

      <div v-else-if="isImage" class="h-full w-full overflow-auto bg-gray-50 flex items-center justify-center">
        <img v-if="blobUrl" :src="blobUrl" class="max-h-full max-w-full object-contain" referrerpolicy="no-referrer" alt="预览" />
      </div>

      <div v-else-if="isPdf" class="h-full w-full bg-gray-50">
        <iframe v-if="blobUrl" :src="blobUrl" class="h-full w-full" title="PDF 预览" />
        <div v-else class="flex h-full items-center justify-center text-gray-500">无法加载 PDF 预览</div>
      </div>

      <div v-else-if="isEditable" class="flex h-full flex-col">
        <div class="border-b px-4 py-2 text-xs text-gray-500">
          {{ isMd ? 'Markdown' : '纯文本' }} · 大小 {{ prettySize }}
        </div>
        <textarea v-model="textContent" class="flex-1 w-full p-3 font-mono text-sm outline-none sm:p-4" placeholder="正在加载内容..." />
        <div v-if="tooLargeHint" class="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">{{ tooLargeHint }}</div>
      </div>

      <!--
        链接视角下的纯文本：内容照常加载（load() 不分视角），但只读。
        不能靠 isEditable=false 掉进下面那个「暂不支持在线预览」分支 ——
        对 .txt 来说那是假消息，而内容明明已经拿到了。
      -->
      <div v-else-if="linkMode && isTextLike" class="flex h-full flex-col">
        <div class="flex items-center justify-between gap-2 border-b px-4 py-2 text-xs text-gray-500">
          <span>{{ isMd ? 'Markdown' : '纯文本' }} · 大小 {{ prettySize }}</span>
          <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">分享链接 · 只读</span>
        </div>
        <pre class="flex-1 w-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-sm outline-none sm:p-4">{{ textContent }}</pre>
      </div>

      <div v-else class="flex h-full items-center justify-center text-gray-500">
        暂不支持该类型的在线预览，可尝试下载。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, toRef, watch } from 'vue'
import ZipPreview from '~/components/ZipPreview.vue'
import SevenZipPreview from '~/components/SevenZipPreview.vue'
import { FilesService } from '~/services/files.service'
import { useFileUpload } from '~/composables/useFileUpload'
import { formatFileSize } from '~/utils/format'
import { notify } from '~/utils/notify'
import type { FileRecord } from '~~/types/file-browser'
import type { ArchiveFileItem } from '~~/types/zip'
import { NO_DOWNLOAD_MESSAGE } from '~~/types/share'

const props = defineProps<{
  file: FileRecord
  currentFolderId: number | null
  targetUserId?: number | null
  /**
   * 分享链接 token。加载和下载都要带上 —— 预览走的就是 /api/files/download，
   * 少了 link 的话匿名访客点开一个文件就是 401。
   */
  link?: string | null
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()
const targetUserIdRef = toRef(props, 'targetUserId')
const currentFileKey = ref(props.file.fileKey)
const replaceInputRef = ref<HTMLInputElement | null>(null)
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
let loadController: AbortController | null = null
let loadId = 0

const { uploading, uploadProgress, uploadFile } = useFileUpload({ targetUserId: targetUserIdRef })

const ext = computed(() => {
  const name = props.file?.filename?.toLowerCase() || ''
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1) : ''
})
const isImage = computed(() => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext.value))
const isPdf = computed(() => ext.value === 'pdf')
const isText = computed(() => ['txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'env'].includes(ext.value))
const isMd = computed(() => ext.value === 'md' || ext.value === 'markdown')
const archiveExtensions = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst', 'lz', 'lzma', 'cab', 'iso', 'arj', 'cpio', 'rpm', 'deb', 'dmg', 'msi', 'xar', 'z'])
const isZip = computed(() => ext.value === 'zip')
const isArchive = computed(() => archiveExtensions.has(ext.value))
const archiveFormat = computed<'zip' | '7z'>(() => isZip.value ? 'zip' : '7z')
/**
 * 链接视角。链接只给读+下载，所以「可编辑」在这里必须为 false ——
 * 否则会渲染出文本编辑框和「保存」按钮，而保存走的是上传接口（没有 link 分支）。
 */
const linkMode = computed(() => !!props.link)
const isTextLike = computed(() => isText.value || isMd.value)
const isEditable = computed(() => !linkMode.value && !isArchive.value && isTextLike.value)
const isZipEntryImage = computed(() => !!zipEntry.value && isImageName(zipEntry.value.filename))
const isZipEntryPdf = computed(() => !!zipEntry.value && extensionOf(zipEntry.value.filename) === 'pdf')
const isZipEntryText = computed(() => !!zipEntry.value && isTextName(zipEntry.value.filename) && zipEntry.value.fileSize <= 10 * 1024 * 1024)
const currentFileSize = computed(() => {
  if (zipEntry.value) return zipEntry.value.fileSize
  if (isEditable.value) return new TextEncoder().encode(textContent.value).length
  return props.file.fileSize
})
const dirty = computed(() => isEditable.value && textContent.value !== originalContent.value)
const prettySize = computed(() => formatFileSize(Math.max(0, Number(currentFileSize.value) || 0)))
const tooLargeHint = computed(() => {
  if (!isEditable.value || props.file.fileSize <= 5 * 1024 * 1024) return ''
  return '提示：文件较大（>5MB），在浏览器中编辑可能会较慢。'
})

const extensionOf = (filename: string) => {
  const name = filename.toLowerCase()
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1) : ''
}
const isImageName = (filename: string) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(extensionOf(filename))
const isTextName = (filename: string) => ['txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'env', 'md', 'markdown'].includes(extensionOf(filename))
const mimeFor = (filename: string) => {
  const extension = extensionOf(filename)
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    pdf: 'application/pdf',
    zip: 'application/zip'
  }
  return types[extension] || 'application/octet-stream'
}

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
  loadController?.abort()
  loadController = null
  cleanupZipEntry()
  revokeBlob()
  archiveBlob.value = null
}

const load = async () => {
  const requestId = ++loadId
  loadController?.abort()
  cleanupZipEntry()
  revokeBlob()
  archiveBlob.value = null
  loading.value = true
  error.value = ''
  textContent.value = ''
  originalContent.value = ''
  try {
    // 服务端不给没有下载位的人 fileKey（真实对象路径）。预览走的就是
    // /api/files/download，没有它必然 400 —— 直接说清原因。
    if (!currentFileKey.value) throw new Error(NO_DOWNLOAD_MESSAGE)
    const sign = await FilesService.downloadSign(
      { fileKey: currentFileKey.value, filename: props.file.filename },
      props.targetUserId ?? null,
      undefined,
      props.link ?? null
    )
    if (!sign.success) throw new Error('获取下载链接失败')
    if (requestId !== loadId) return
    const controller = new AbortController()
    loadController = controller
    const response = await fetch(sign.data.downloadUrl, { method: 'GET', signal: controller.signal })
    if (!response.ok) throw new Error('拉取文件内容失败')
    if (requestId !== loadId) return

    if (isEditable.value) {
      const text = await response.text()
      originalContent.value = text
      textContent.value = text
    } else if (isImage.value || isPdf.value) {
      const blob = await response.blob()
      if (requestId === loadId) blobUrl.value = URL.createObjectURL(blob)
    } else if (isArchive.value) {
      archiveBlob.value = await response.blob()
    }
  } catch (e: any) {
    if (requestId === loadId && e?.name !== 'AbortError') error.value = e?.message || '加载失败'
  } finally {
    if (requestId === loadId) {
      loading.value = false
      loadController = null
    }
  }
}

const getZipPassword = () => {
  if (!zipEntry.value?.encrypted) return ''
  const value = window.prompt('该文件已加密，请输入压缩包密码：')
  return value === null ? null : value
}

const openZipEntry = async (item: ArchiveFileItem) => {
  cleanupZipEntry()
  zipEntry.value = item
  if (typeof window !== 'undefined' && item.encrypted) {
    const password = getZipPassword()
    if (password === null) {
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
    const blob = new Blob([textContent.value], { type })
    const newFile = new File([blob], props.file.filename, { type })
    currentFileKey.value = await uploadFile(newFile, {
      folderId: props.currentFolderId ?? null,
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
      folderId: props.currentFolderId ?? null,
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
      undefined,
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

watch(() => props.file?.id, (id) => {
  if (id === undefined) return
  currentFileKey.value = props.file.fileKey
  void load()
}, { immediate: true })

watch(() => props.file?.fileKey, (key) => {
  if (key) currentFileKey.value = key
})

onBeforeUnmount(() => cleanup())
</script>
