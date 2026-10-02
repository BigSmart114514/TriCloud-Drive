// ~/composables/useFolderDownload.ts
import { ref, type Ref } from 'vue'
import { FoldersService } from '~/services/folders.service'
import { FilesService } from '~/services/files.service'
import { createZipSink } from '~/utils/zipper'
import { formatFileSize } from '~/utils/format'
import type { FolderRecord } from '~/types/files'

export function useFolderDownload(options?: {
  targetUserId?: Ref<number | null | undefined>
  useAdmin?: Ref<boolean | null | undefined>
  /** 分享链接视角。两个请求都要带，否则匿名过不了中间件 */
  link?: Ref<string | null | undefined>
}) {
  const tRef = options?.targetUserId
  const admin = () => options?.useAdmin?.value || undefined
  const link = () => options?.link?.value || null
  const downloadingFolderId = ref<number | null>(null)

  const downloadFolder = async (folder: FolderRecord) => {
    if (downloadingFolderId.value) return
    downloadingFolderId.value = folder.id
    try {
      const t = tRef?.value ?? null
      const a = admin()
      const l = link()
      /**
       * 链接视角下服务端已经把清单按链接能覆盖的范围过滤过了
       * （非继承节点往下整支排除），所以逐个签名不会中途 403。
       * 少了 link 的话清单会走「按人查权限」，访客直接 401。
       */
      const manifest = await FoldersService.manifest(folder.id, t, a, l)
      if (!manifest?.success) throw new Error('无法获取清单')
      if (!manifest.files?.length) {
        notify('该文件夹为空','error')
        return
      }
      const go = confirm(`将打包下载 "${folder.name}"（${manifest.totals.count} 个文件，共约 ${formatFileSize(manifest.totals.bytes)}）。继续？`)
      if (!go) return

      const sink = await createZipSink(`${folder.name}.zip`)
      for (const item of manifest.files) {
        const sign = await FilesService.downloadSign({ fileKey: item.fileKey, filename: item.filename }, t, a, l)
        if (!sign?.success) throw new Error(`签名失败: ${item.filename}`)
        const entryPath = [folder.name, item.relDir, item.filename].filter(Boolean).join('/')
        await sink.addFromUrl(entryPath, sign.data.downloadUrl)
      }
      await sink.close()
      notify('打包完成，已保存。', 'success')
    } catch (e) {
      notifyError(e, '文件夹下载失败，请稍后重试')
    } finally {
      downloadingFolderId.value = null
    }
  }

  return { downloadingFolderId, downloadFolder }
}