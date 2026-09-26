// server/api/files/index.get.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { FileService, FolderService } from '~~/server/utils/db'
import { getQuery } from 'h3'

export default defineEventHandler(async (event) => {
  try {
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const { targetUserId } = await getMeAndTarget(event)
    const { folderId: rawFolderId } = getQuery(event) as { folderId?: string }

    const fileService = new FileService(db)
    const folderService = new FolderService(db)

    // 解析 folderId，root / 0 / 缺省都视为根层
    let folderId: number | null = null
    if (rawFolderId && rawFolderId !== 'root' && rawFolderId !== '0') {
      const parsed = Number(rawFolderId)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw createError({ statusCode: 400, statusMessage: '非法的 folderId' })
      }
      folderId = parsed
    }

    // 目录归属校验，非本人目录直接 404
    await folderService.assertOwned(targetUserId, folderId)

    const [folders, files] = await Promise.all([
      folderService.listChildren(targetUserId, folderId),
      fileService.listByFolder(targetUserId, folderId)
    ])

    return {
      success: true,
      currentFolderId: folderId,
      folders,
      files
    }
  } catch (error: any) {
    console.error('Get items error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '获取列表失败' })
  }
})
