import type { FileRecord } from '~/types/files.ts'

export const FilesService = {
  /**
   * 列目录。
   *
   * `link` 走 **query**（不是 body）：分享链接的匿名放行由中间件判定，
   * 而中间件只读 query、不碰 body（body 在 handler 里还要再读一次，
   * 缓存行为不该依赖中间件先读过）。
   *
   * 带 link 时服务端走完全独立的 listByLink 分支，**与登录态无关** ——
   * 登录用户带链接也一样只拿 LINK_PERMISSION，链接永不提权。
   */
  async list(folderId: number | null, targetUserId?: number | null, useAdmin?: boolean, link?: string | null) {
    const params: any = { folderId: folderId ?? 'root' }
    // useAdmin 独立传：首页选人浏览要「分享权限」视角（不传），
    // /manage/files 要「管理权限」视角（传 true）。服务端据此决定
    // authUserId 是我还是属主。与 targetUserId 无关，别绑在一起。
    if (targetUserId) params.targetUserId = targetUserId
    if (useAdmin) params.useAdmin = 1
    if (link) params.link = link
    return await $fetch<{
      success: boolean
      currentFolderId: number | null
      /** 根层且在看别人的树 = 「分享给我的」平铺清单，里面没有可粘的目标目录 */
      sharedList: boolean
      /** 当前目录我能不能写（共享视图据此给不给上传/新建/粘贴） */
      canWrite: boolean
      isOwner: boolean
      /**
       * 服务端走的是链接分支。匿名访问者恒为 false。
       * 前端据此把上传/新建/粘贴/分享这类入口全关掉 —— 服务端本来也拦
       * （那些接口没有 link 分支），但不给入口比点了报错好。
       */
      linkMode?: boolean
      folder?: { id: number; name: string } | null
      folders: any[]
      files: any[]
    }>('/api/files', { params })
  },

  /**
   * 拿下载签名。`link` 同样走 query（中间件只认 query）。
   *
   * 链接分支是**排他**的：服务端带了 link 就完全不看登录态，
   * 所以属主自己用链接下载也只拿到读+下载。
   */
  async downloadSign(
    file: Pick<FileRecord, 'fileKey' | 'filename'>,
    targetUserId?: number | null,
    useAdmin?: boolean,
    link?: string | null
  ) {
    const body: any = { fileKey: file.fileKey, filename: file.filename }
    if (targetUserId) body.targetUserId = targetUserId
    if (useAdmin) body.useAdmin = 1
    return await $fetch<{ success: boolean; data: { downloadUrl: string; filename: string } }>(
      '/api/files/download',
      { method: 'POST', body, query: link ? { link } : undefined }
    )
  },

  async delete(id: number, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { fileId: id }
    if (targetUserId) body.targetUserId = targetUserId
    if (useAdmin) body.useAdmin = 1
    return await $fetch<{ success: boolean; statusMessage?: string }>('/api/files/delete', {
      method: 'POST',
      body
    })
  },

  async rename(id: number, newName: string, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { fileId: id, newName }
    if (targetUserId) body.targetUserId = targetUserId
    if (useAdmin) body.useAdmin = 1
    return await $fetch<{ success: boolean; file?: FileRecord; statusMessage?: string }>('/api/files/rename', {
      method: 'POST',
      body
    })
  }
}