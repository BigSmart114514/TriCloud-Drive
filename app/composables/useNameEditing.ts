// ~/composables/useNameEditing.ts
import { type Ref } from 'vue'
import { FilesService } from '~/services/files.service'
import { FoldersService } from '~/services/folders.service'
import { openPrompt } from '~/composables/usePromptDialog'
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

  /**
   * 名字校验。原来是提交后才跑、跑不过弹 toast；现在作为弹窗的 `validate` 传进去 ——
   * 不合格时弹窗**留着**，用户可以就地改。判定规则逐字没变。
   *
   * 「不能为空」不在这里判：openPrompt 内建了它，省掉一处就不会漏
   * （原来 createFolder 与 validateName 各判了一次，其实重复）。
   */
  const nameValidator = (isFolder: boolean, transform?: (raw: string) => string) =>
    (value: string): string => {
      const effective = transform ? transform(value) : value
      return validateName(effective, isFolder)
    }

  const createFolder = async () => {
    // 取消（null）与空值都在这里归为「不做」—— 与原来的 `prompt(...)?.trim()`
    // 之后 `if (!name) return` 完全一致。名字是要 trim 的（首尾空格在文件系统
    // 与界面上都是噪声），密码才不。
    const name = await openPrompt({
      title: '新建文件夹',
      label: '文件夹名称',
      placeholder: '新文件夹',
      confirmText: '创建',
      trim: true,
      validate: nameValidator(true)
    })
    if (!name) return
    try {
      const res = await FoldersService.create(name, currentFolderId.value ?? null, tRef?.value ?? null, admin())
      if (res.success) await fetchFiles()
      else notify(res.statusMessage || '创建失败', 'error')
    } catch (e) {
      notifyError(e, '创建文件夹失败')
    }
  }

  const renameFolder = async (folder: FolderRecord) => {
    const entered = await openPrompt({
      title: '重命名文件夹',
      label: '文件夹名称',
      defaultValue: folder.name,
      confirmText: '保存',
      trim: true,
      validate: nameValidator(true)
    })
    // null = 取消。这与「填了但不合格」不同：后者弹窗还开着，用户能继续改。
    if (entered == null) return
    const newName = entered.trim()
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
    // 校验走的是「补完扩展名之后」的最终名字 —— 与原来一致。用户删掉扩展名
    // 不会让 255 字符的判定落空，因为服务端收到的是补完的那个名字。
    const entered = await openPrompt({
      title: '重命名文件',
      label: '文件名',
      defaultValue: file.filename,
      confirmText: '保存',
      trim: true,
      validate: nameValidator(false, (raw) => keepExtIfNone(file.filename, raw))
    })
    if (entered == null) return
    const finalName = keepExtIfNone(file.filename, entered)
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

  // keepExtIfNone / validateName 只在本 composable 内部用（renameFile 与
  // createFolder/renameFolder 都调它们），所以不放进返回值 —— 放进来的话
  // 每个消费方都能看到，却只有这里用。
  return {
    createFolder,
    renameFolder,
    renameFile
  }
}