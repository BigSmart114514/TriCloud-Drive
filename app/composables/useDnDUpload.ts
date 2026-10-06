import { ref, type Ref } from 'vue'
import { withScopeRef } from '~/utils/scope'
// toPosix 不在这里 import：它的唯一调用方已经搬进 drop.ts 了，
// 带过来就是「import 了但正文不用」，tsc 不报（noUnusedLocals 没开），
// 读代码的人却要多查一次。
import { classifyDrop, entriesFromWebkitRelativePath, normalizeDir } from '~/utils/drop'

type UploadMultipleFiles = (files: File[], opts: { folderId: number | null; overwrite: boolean; skip: boolean }) => Promise<void>
type Entry = { file: File; relativePath: string }

export function useDnDUpload(
  currentFolderId: Ref<number | null>,
  uploadMultipleFiles: UploadMultipleFiles,
  fetchFiles: () => Promise<void>,
  clearSelection: () => void,
  options?: {
    targetUserId?: Ref<number | null | undefined>
    /** 显式传，别用「有没有 targetUserId」推断，理由同 useFileUpload */
    useAdmin?: Ref<boolean | null | undefined>
  }
) {
  const tRef = options?.targetUserId
  const useAdmin = options?.useAdmin
  const isDragging = ref(false)
  const dragCounter = ref(0)

  const fileInputRef = ref<HTMLInputElement | null>(null)
  const folderInputRef = ref<HTMLInputElement | null>(null)
  const overwriteExisting = ref(false)
  const skipExisting = ref(false)

  const onDragEnter = () => { dragCounter.value++; isDragging.value = true }
  const onDragLeave = () => {
    dragCounter.value = Math.max(0, dragCounter.value - 1)
    if (dragCounter.value === 0) isDragging.value = false
  }

  const handleDrop = async (event: DragEvent) => {
    dragCounter.value = 0
    isDragging.value = false

    // 分类与实体化的理由全在 ~/utils/drop 的文件头，这里只说时序上的两件事：
    //
    // 1. **先读 .files，再碰 .items。** 调 webkitGetAsEntry() 会把 item 锁进
    //    protected 状态，之后 `dataTransfer.files` 就返回空了。原来的写法反了
    //    （先 .some() 再读 .files），于是「判断有没有文件夹」这个动作本身会
    //    把后面要用的文件列表清空。
    //
    // 2. **每个 item 最多实体化一次。** 原来 .some() 调一次、
    //    getFilesFromDataTransferItems 里又调一次，第二次在已消费的 item 上返回
    //    null，被 `if (!entry) continue` 静默跳过 —— 拖文件夹会漏文件且不报错。
    //    现在 entry 只从 needsEntry 里取一次，传给遍历函数，不再二次调用。
    const items: any[] = Array.from(event.dataTransfer?.items || [])
    const { mode, needsEntry } = classifyDrop(items)

    if (mode === 'dirs') {
      const entries = await getFilesFromEntries(needsEntry)
      if (entries.length) {
        await handleEntries(entries)
        return
      }
      // 实体化后一个都没拿到（浏览器不支持、或全是空条目）：退回 .files，
      // 与纯文件同一条路。别在这里静默什么都不做。
    }

    const fls = Array.from(event.dataTransfer?.files || [])
    if (fls.length > 0) await handleFiles(fls)
  }

  const handleFileSelect = async (event: Event) => {
    const target = event.target as HTMLInputElement
    const fls = Array.from(target.files || [])
    if (!fls.length) return
    await handleFiles(fls)
    if (fileInputRef.value) fileInputRef.value.value = ''
  }

  const handleFolderSelect = async (event: Event) => {
    const input = event.target as HTMLInputElement
    const fls = Array.from(input.files || [])
    if (!fls.length) return
    // 路径归一规则与拖拽共用（~/utils/drop）：两边各写一遍的话，改了规则只有
    // 一边会跟上。
    const entries: Entry[] = entriesFromWebkitRelativePath(fls)
    await handleEntries(entries)
    if (folderInputRef.value) folderInputRef.value.value = ''
  }

  const handleFiles = async (fls: File[]) => {
    try {
      await uploadMultipleFiles(fls, {
        folderId: currentFolderId.value ?? null,
        overwrite: overwriteExisting.value,
        skip: skipExisting.value,
      })
      clearSelection()
      await fetchFiles()
    } catch (error) {
      notifyError(error, '文件上传失败')
    }
  }

  const handleEntries = async (entries: Entry[]) => {
    const uniqueDirs = Array.from(new Set(entries.map(e => e.relativePath).filter(Boolean)))
    const baseParentId = currentFolderId.value ?? null
    const dirMap = await ensurePaths(uniqueDirs, baseParentId)

    const groups = new Map<string, File[]>()
    for (const { file, relativePath } of entries) {
      const key = relativePath || '__ROOT__'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(file)
    }

    for (const [dir, fls] of groups) {
      const folderId = dir === '__ROOT__' ? baseParentId : (dirMap[dir] ?? baseParentId)
      try {
        await uploadMultipleFiles(fls, { folderId, overwrite: overwriteExisting.value, skip: skipExisting.value, })
      } catch (e) {
        notifyError(e, '文件夹内文件上传失败')
      }
    }

    clearSelection()
    await fetchFiles()
  }

  const ensurePaths = async (paths: string[], parentId: number | null) => {
    if (!paths.length) return {} as Record<string, number | null>
    try {
      const body: any = { parentId, paths }
        withScopeRef(body, tRef, useAdmin)
      const res = await $fetch<{ success: boolean; map: Record<string, number> }>('/api/folders/ensure-paths', {
        method: 'POST',
        body
      })
      return res?.map || {}
    } catch (e) {
      notifyError(e, '创建目录失败')
      return {}
    }
  }

  // 目录遍历辅助...
  const readAllDirectoryEntries = (reader: any): Promise<any[]> => new Promise((resolve) => {
    const entries: any[] = []
    const readBatch = () => {
      reader.readEntries((batch: any[]) => {
        if (batch.length === 0) resolve(entries)
        else { entries.push(...batch); readBatch() }
      }, () => resolve(entries))
    }
    readBatch()
  })

  const traverseDirectoryEntry = async (dirEntry: any, path: string): Promise<Entry[]> => {
    const reader = dirEntry.createReader()
    const children = await readAllDirectoryEntries(reader)
    const result: Entry[] = []
    for (const entry of children) {
      if (entry.isFile) {
        const file: File = await new Promise((res) => entry.file(res))
        result.push({ file, relativePath: normalizeDir(path) })
      } else if (entry.isDirectory) {
        const subPath = path ? `${path}/${entry.name}` : entry.name
        const subFiles = await traverseDirectoryEntry(entry, subPath)
        result.push(...subFiles)
      }
    }
    return result
  }

  /**
   * 把一批 item 实体化成条目。
   *
   * `webkitGetAsEntry()` **只在这里调一次，且只对 classifyDrop 挑出来的那批**。
   * 理由见 ~/utils/drop 的文件头：调它会让 Chrome 把 item 实体化成沙箱副本
   * （macOS 上用户能在 ~/Downloads 里看到），所以纯文件拖拽绝不能碰它。
   *
   * 用 entry 而不是 `getAsFile()`，是因为后者拿不到目录结构 —— 要保住
   * 「拖文件夹进来带层级」这个能力，只能走 entry 这条会实体化的路。
   */
  const getFilesFromEntries = async (items: any[]) => {
    const results: Entry[] = []
    for (const item of items) {
      // 每个 item 只到这里一次，所以拿不到「已消费」的 null
      const entry = typeof item?.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      if (!entry) continue
      if (entry.isFile) {
        const file: File = await new Promise((res) => entry.file(res))
        results.push({ file, relativePath: '' })
      } else if (entry.isDirectory) {
        const files = await traverseDirectoryEntry(entry, entry.name)
        results.push(...files)
      }
    }
    return results.map(r => ({ file: r.file, relativePath: normalizeDir(r.relativePath) }))
  }

  return {
    isDragging,
    onDragEnter,
    onDragLeave,
    fileInputRef,
    folderInputRef,
    overwriteExisting,
    handleDrop,
    handleFileSelect,
    handleFolderSelect,
    skipExisting
  }
}