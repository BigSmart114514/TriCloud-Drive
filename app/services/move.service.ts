import { $fetch } from 'ofetch'
import { withScope } from '~/utils/scope'

export const MoveService = {
  async paste(targetFolderId: number | null, folderIds: number[], fileIds: number[], targetUserId?: number | null, overwriteExisting?: boolean | null, skipExisting?: boolean | null, useAdmin?: boolean) {
    const body: any = { targetFolderId, folderIds, fileIds, overwrite: overwriteExisting, skipIfExist: skipExisting }
    withScope(body, { targetUserId, useAdmin })
    return $fetch('/api/files/move', {
      method: 'POST',
      body
    }) as Promise<{
      success: boolean
      statusMessage?: string
      moved?: { folders: number; files: number }
      skipped:number
      failed: number
    }>
  }
}