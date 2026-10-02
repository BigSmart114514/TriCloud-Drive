import { withScope } from '~/utils/scope'
import type { FolderRecord, FolderManifest } from '~/types/files'

export const FoldersService = {
  async create(name: string, parentId: number | null, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { name, parentId }
    withScope(body, { targetUserId, useAdmin })
    return await $fetch<{ success: boolean; folder?: FolderRecord; statusMessage?: string }>(
      '/api/folders/create',
      { method: 'POST', body }
    )
  },

  async delete(id: number, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { folderId: id }
    withScope(body, { targetUserId, useAdmin })
    return await $fetch<{ success: boolean; statusMessage?: string }>('/api/folders/delete', {
      method: 'POST',
      body
    })
  },

  async rename(id: number, newName: string, targetUserId?: number | null, useAdmin?: boolean) {
    const body: any = { folderId: id, newName }
    withScope(body, { targetUserId, useAdmin })
    return await $fetch<{ success: boolean; folder?: FolderRecord; statusMessage?: string }>(
      '/api/folders/rename',
      { method: 'POST', body }
    )
  },

  /**
   * 整包下载的清单。
   *
   * 带 link 时服务端按**链接能覆盖的那部分子树**过滤，不是整棵 ——
   * 任何非继承节点（自己那道边界）往下整支被排除。所以这里的 files
   * 拿回来就能直接逐个签名下载，不会中途 403。
   *
   * `link` 走 query：与 FilesService.list / downloadSign 同一个理由
   * （中间件只读 query）。
   */
  async manifest(folderId: number, targetUserId?: number | null, useAdmin?: boolean, link?: string | null) {
    const params: any = { folderId }
    withScope(params, { targetUserId, useAdmin })
    if (link) params.link = link
    return await $fetch<FolderManifest>('/api/folders/manifest', {
      method: 'GET',
      params
    })
  }
}