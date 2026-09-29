import type { FileRecord } from '~/types/files.ts'

export const FilesService = {
  async list(folderId: number | null, targetUserId?: number | null, useAdmin?: boolean) {
    const params: any = { folderId: folderId ?? 'root' }
    // useAdmin 独立传：首页选人浏览要「分享权限」视角（不传），
    // /manage/files 要「管理权限」视角（传 true）。服务端据此决定
    // authUserId 是我还是属主。与 targetUserId 无关，别绑在一起。
    if (targetUserId) params.targetUserId = targetUserId
    if (useAdmin) params.useAdmin = 1
    return await $fetch<{
      success: boolean
      currentFolderId: number | null
      /** 根层且在看别人的树 = 「分享给我的」平铺清单，里面没有可粘的目标目录 */
      sharedList: boolean
      /** 当前目录我能不能写（共享视图据此给不给上传/新建/粘贴） */
      canWrite: boolean
      isOwner: boolean
      folders: any[]
      files: any[]
    }>('/api/files', { params })
  },

  async downloadSign(file: Pick<FileRecord, 'fileKey' | 'filename'>, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { fileKey: file.fileKey, filename: file.filename }
    if (targetUserId) body.targetUserId = targetUserId
    if (useAdmin) body.useAdmin = 1
    return await $fetch<{ success: boolean; data: { downloadUrl: string; filename: string } }>(
      '/api/files/download',
      { method: 'POST', body }
    )
  },

  async delete(id: number, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { fileId: id }
    if (targetUserId) body.targetUserId = targetUserId
    if (useAdmin) body.useAdmin = 1
    return await $fetch<{ success: boolean; message?: string }>('/api/files/delete', {
      method: 'POST',
      body
    })
  },

  async rename(id: number, newName: string, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { fileId: id, newName }
    if (targetUserId) body.targetUserId = targetUserId
    if (useAdmin) body.useAdmin = 1
    return await $fetch<{ success: boolean; file?: FileRecord; message?: string }>('/api/files/rename', {
      method: 'POST',
      body
    })
  }
}