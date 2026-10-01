// ~/composables/useBulkActions.ts
import { FilesService } from '~/services/files.service'
import { FoldersService } from '~/services/folders.service'
import { triggerDownload } from '~/utils/download'
import { createZipSink } from '~/utils/zipper'
import { formatFileSize } from '~/utils/format'
import type { FolderRecord, FileRecord } from '~/types/files'
import { ref, type Ref } from 'vue'
import { notify, notifyError, toMessage } from '~/utils/notify'

export function useBulkActions(
  folders: Ref<FolderRecord[]>,
  files: Ref<FileRecord[]>,
  selectedFolderIds: Ref<Set<number>>,
  selectedFileIds: Ref<Set<number>>,
  options?: {
    targetUserId?: Ref<number | null | undefined>
    /** 显式传。/manage/files 传 true 才能代删，首页侧栏不传 */
    useAdmin?: Ref<boolean | null | undefined>
    /** 分享链接视角。下载/整包下载都要带上，否则匿名请求过不了中间件 */
    link?: Ref<string | null | undefined>
  }
) {
  const tRef = options?.targetUserId
  const admin = () => options?.useAdmin?.value || undefined
  const link = () => options?.link?.value || null
  const bulkDeleting = ref(false)
  const bulkDownloading = ref(false)
  const downloadingFolderId = ref<number | null>(null)

  const downloadFile = async (file: FileRecord) => {
    try {
      const res = await FilesService.downloadSign({ fileKey: file.fileKey, filename: file.filename }, tRef?.value ?? null, admin(), link())
      if (res.success) triggerDownload(res.data.downloadUrl, res.data.filename)
      else {
        notify(res?.statusMessage || '下载文件失败','error')
      }
    } catch (e) {
      notifyError(e, '下载文件失败')
    }
  }

  const deleteFile = async (file: FileRecord) => {
    const ok = confirm(`确定要删除文件 "${file.filename}" 吗？`)
    if (!ok) return
    try {
      const res = await FilesService.delete(file.id, tRef?.value ?? null, admin())
      if (res.success) {
        files.value = files.value.filter(f => f.id !== file.id)
        selectedFileIds.value.delete(file.id)
        notify('文件删除成功', 'success')
      } else {
        notify(res.statusMessage || '删除失败', 'error')
      }
    } catch (e) {
      notifyError(e, '删除文件失败')
    }
  }

  const deleteFolder = async (folder: FolderRecord) => {
    const ok = confirm(`确定要删除文件夹 "${folder.name}" 吗？\n将同时删除其所有子文件夹与文件，操作不可恢复。`)
    if (!ok) return
    try {
      const res = await FoldersService.delete(folder.id, tRef?.value ?? null, admin())
      if (res.success) {
        folders.value = folders.value.filter(f => f.id !== folder.id)
        selectedFolderIds.value.delete(folder.id)
        notify('文件夹删除成功','success')
      } else {
        notify(res.statusMessage || '删除失败','error')
      }
    } catch (e) {
      notifyError(e, '删除文件夹失败')
    }
  }

  const deleteSelected = async () => {
    const fileIds = [...selectedFileIds.value]
    const folderIds = [...selectedFolderIds.value]
    if (fileIds.length + folderIds.length === 0) return

    const ok = confirm(
      `确定要删除选中的 ${folderIds.length} 个文件夹和 ${fileIds.length} 个文件吗？\n` +
      `删除文件夹将同时删除其所有子内容，操作不可恢复。`
    )
    if (!ok) return

    bulkDeleting.value = true
    try {
      const t = tRef?.value ?? null
      const a = admin()
      const tasks = [
        ...fileIds.map(id => FilesService.delete(id, t, a).then(r => ({ ok: r.success, id, type: 'file', statusMessage: r.statusMessage })).catch(e => ({ ok: false, id, type: 'file', statusMessage: toMessage(e, '删除失败') }))),
        ...folderIds.map(id => FoldersService.delete(id, t, a).then(r => ({ ok: r.success, id, type: 'folder', statusMessage: r.statusMessage })).catch(e => ({ ok: false, id, type: 'folder', statusMessage: toMessage(e, '删除失败') })))
      ]
      const results = await Promise.all(tasks)
      const okFiles = results.filter(r => r.ok && r.type === 'file').map(r => r.id as number)
      const okFolders = results.filter(r => r.ok && r.type === 'folder').map(r => r.id as number)

      if (okFiles.length) files.value = files.value.filter(f => !okFiles.includes(f.id))
      if (okFolders.length) folders.value = folders.value.filter(f => !okFolders.includes(f.id))
      okFiles.forEach(id => selectedFileIds.value.delete(id))
      okFolders.forEach(id => selectedFolderIds.value.delete(id))

      const failed = results.filter(r => !r.ok)
      if (failed.length) {
        notify(`部分删除失败：${failed.length} 项。\n` + failed.slice(0, 5).map(r =>
          `${r.type === 'folder' ? '文件夹' : '文件'} #${r.id}: ${r.statusMessage || '失败'}`
        ).join('\n'),'error')
      } else {
        notify('删除成功','success')
      }
    } finally {
      bulkDeleting.value = false
    }
  }

  const downloadSelected = async () => {
    const selFolders = folders.value.filter(f => selectedFolderIds.value.has(f.id))
    const selFiles = files.value.filter(f => selectedFileIds.value.has(f.id))
    if (selFolders.length + selFiles.length === 0) return

    // 只有文件：逐个下载
    if (selFolders.length === 0) {
      bulkDownloading.value = true
      try {
        for (const f of selFiles) await downloadFile(f)
      } finally {
        bulkDownloading.value = false
      }
      return
    }

    // 含文件夹：打包
    bulkDownloading.value = true
    try {
      const t = tRef?.value ?? null
      const a = admin()
      const l = link()
      // 链接视角下服务端已经按链接范围过滤过了（整包下载只给能覆盖的那部分），
      // 所以这里拿到的清单可以直接逐个签名，不会中途 403。
      const manifests = await Promise.all(selFolders.map(f => FoldersService.manifest(f.id, t, a, l)))
      const totalFolderBytes = manifests.reduce((acc, m) => acc + (m.totals?.bytes || 0), 0)
      const totalFileBytes = selFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0)
      const totalBytes = totalFolderBytes + totalFileBytes

      const zipName = (selFolders.length === 1 && selFiles.length === 0)
        ? `${selFolders[0].name}.zip`
        : '选中项.zip'

      const go = confirm(`将打包下载 ${selFolders.length} 个文件夹和 ${selFiles.length} 个文件，共约 ${formatFileSize(totalBytes)}。继续？`)
      if (!go) return

      const sink = await createZipSink(zipName)

      // 文件夹条目（保持原有相对路径）
      for (const m of manifests) {
        for (const item of m.files) {
          const sign = await FilesService.downloadSign({ fileKey: item.fileKey, filename: item.filename }, t, a, l)
          if (!sign.success) throw new Error(`签名失败: ${item.filename}`)
          const entryPath = [m.folder.name, item.relDir, item.filename].filter(Boolean).join('/')
          await sink.addFromUrl(entryPath, sign.data.downloadUrl)
        }
      }

      // 选中的散文件放在 zip 根目录
      for (const f of selFiles) {
        const sign = await FilesService.downloadSign({ fileKey: f.fileKey, filename: f.filename }, t, a, l)
        if (!sign.success) throw new Error(`签名失败: ${f.filename}`)
        await sink.addFromUrl(f.filename, sign.data.downloadUrl)
      }

      await sink.close()
      notify('打包完成，已保存。','success')
    } catch (e) {
      notifyError(e, '批量下载失败，请稍后重试')
    } finally {
      bulkDownloading.value = false
    }
  }

  return {
    bulkDeleting, bulkDownloading, downloadingFolderId,
    downloadFile, deleteFile, deleteFolder,
    deleteSelected, downloadSelected
  }
}