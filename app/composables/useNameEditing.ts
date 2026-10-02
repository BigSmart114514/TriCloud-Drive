// ~/composables/useNameEditing.ts
import { type Ref } from 'vue'
import { FilesService } from '~/services/files.service'
import { FoldersService } from '~/services/folders.service'
import type { FolderRecord, FileRecord } from '~/types/files'

export function useNameEditing(
  folders: Ref<FolderRecord[]>,
  files: Ref<FileRecord[]>,
  breadcrumbs: Ref<Array<{ id: number | null; name: string }>>,
  currentFolderId: Ref<number | null>,
  fetchFiles: () => Promise<void>,
  options?: {
    targetUserId?: Ref<number | null | undefined>
    /** 显式传。/manage/files 传 true 才能代建/代改名 */
    useAdmin?: Ref<boolean | null | undefined>
  }
) {
  const tRef = options?.targetUserId
  const admin = () => options?.useAdmin?.value || undefined

  const keepExtIfNone = (oldName: string, entered: string) => {
    const trim = (entered || '').trim()
    if (!trim) return trim
    const hasExt = /\.[^./\\]+$/.test(trim)  // 修正正则
    if (hasExt) return trim
    const oldExt = oldName.match(/\.[^./\\]+$/)?.[0] || ''  // 修正正则
    return trim + oldExt
  }

  const validateName = (name: string, isFolder = false) => {
    if (!name || !name.trim()) return '名称不能为空'
    if (name.length > 255) return '名称过长（最多255字符）'
    if (/[\\/]/.test(name)) return '名称不可包含斜杠/反斜杠'
    if (isFolder && (name === '.' || name === '..')) return '非法的文件夹名称'
    return ''
  }

  const createFolder = async () => {
    const name = prompt('请输入新建文件夹名称：')?.trim()
    if (!name) return
    if (name.length > 255) return notify('文件夹名称过长（最多255字符）','error')
    try {
      const res = await FoldersService.create(name, currentFolderId.value ?? null, tRef?.value ?? null, admin())
      if (res.success) await fetchFiles()
      else notify(res.statusMessage || '创建失败', 'error')
    } catch (e) {
      notifyError(e, '创建文件夹失败')
    }
  }

  const renameFolder = async (folder: FolderRecord) => {
    const entered = prompt('请输入新的文件夹名称：', folder.name)
    if (entered == null) return
    const newName = entered.trim()
    const err = validateName(newName, true)
    if (err) return notify(err, 'error')
    if (newName === folder.name) return
    try {
      const res = await FoldersService.rename(folder.id, newName, tRef?.value ?? null, admin())
      if (!res.success) return notify(res.statusMessage || '重命名失败', 'error')

      const idx = folders.value.findIndex(f => f.id === folder.id)
      if (idx >= 0) folders.value[idx].name = newName
      breadcrumbs.value = breadcrumbs.value.map(c => c.id === folder.id ? { ...c, name: newName } : c)
    } catch (e) {
      notifyError(e, '重命名文件夹失败')
    }
  }

  const renameFile = async (file: FileRecord) => {
    const entered = prompt('请输入新的文件名：', file.filename)
    if (entered == null) return
    const finalName = keepExtIfNone(file.filename, entered)
    const err = validateName(finalName)
    if (err) return notify(err, 'error')
    if (finalName === file.filename) return
    try {
      const res = await FilesService.rename(file.id, finalName, tRef?.value ?? null, admin())
      if (!res.success) return notify(res.statusMessage || '重命名失败', 'error')
      const idx = files.value.findIndex(f => f.id === file.id)
      if (idx >= 0) files.value[idx].filename = finalName
    } catch (e) {
      notifyError(e, '重命名文件失败')
    }
  }

  return {
    keepExtIfNone,
    validateName,
    createFolder,
    renameFolder,
    renameFile
  }
}