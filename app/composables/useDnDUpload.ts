import { ref, type Ref } from 'vue'

type UploadMultipleFiles = (files: File[], opts: { folderId: number | null; overwrite: boolean; skip: boolean }) => Promise<void>
type Entry = { file: File; relativePath: string }
const toPosix = (p: string) => p.replace(/\\/g, '/')
const normalizeDir = (p: string) => toPosix(p).replace(/^\/+|\/+$/g, '')

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
    const items = Array.from(event.dataTransfer?.items || [])
    if (items.some((it: any) => typeof it.webkitGetAsEntry === 'function' && it.webkitGetAsEntry()?.isDirectory)) {
      const entries = await getFilesFromDataTransferItems(items as any)
      if (entries.length) { await handleEntries(entries); return }
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
    const entries: Entry[] = fls.map((f) => {
      const rpRaw = (f as any).webkitRelativePath || f.name
      const rp = toPosix(rpRaw)
      const dir = rp.includes('/') ? rp.slice(0, rp.lastIndexOf('/')) : ''
      return { file: f, relativePath: normalizeDir(dir) }
    })
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
        if (tRef?.value) body.targetUserId = tRef.value
        if (useAdmin?.value) body.useAdmin = 1
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

  const getFilesFromDataTransferItems = async (items: DataTransferItem[]) => {
    const results: Entry[] = []
    for (const item of items) {
      const entry = (item as any).webkitGetAsEntry?.()
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