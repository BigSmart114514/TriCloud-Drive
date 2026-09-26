// server/api/files/index.get.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { FileService, FolderService } from '~~/server/utils/db'
import { hasPermission, PERM_ALL, PERM_READ } from '~~/types/share'
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

    // 属主或对该目录有读权限的被授权人都能浏览；其余一律 404
    const ownedFolder = folderId === null ? null : await folderService.findOwnedById(targetUserId, folderId)
    const isOwner = folderId === null || !!ownedFolder

    let dirAccessMask = PERM_ALL
    let subtreeOwnerId = targetUserId
    if (!isOwner) {
      const access = await folderService.resolveAccess(targetUserId, folderId)
      if (!hasPermission(access.mask, PERM_READ)) {
        throw createError({ statusCode: 404, statusMessage: '文件夹不存在或无权限' })
      }
      dirAccessMask = access.mask
      subtreeOwnerId = (await folderService.getOwnerId(folderId!)) ?? targetUserId
    }

    // 目录级只解析一次；子树的行都属于属主，用属主 id 过滤即可
    const [folders, allFiles] = await Promise.all([
      isOwner ? folderService.listChildren(subtreeOwnerId, folderId) : [],
      fileService.listFolderContents(folderId, subtreeOwnerId)
    ])

    // 被授权人只能看到自己有权访问的文件
    const files = isOwner
      ? allFiles
      : await fileService.filterAccessible(targetUserId, allFiles, {
          boundary: true,
          isPublic: false,
          mask: dirAccessMask
        })

    return {
      success: true,
      currentFolderId: folderId,
      isOwner,
      folders,
      files
    }
  } catch (error: any) {
    console.error('Get items error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '获取列表失败' })
  }
})
