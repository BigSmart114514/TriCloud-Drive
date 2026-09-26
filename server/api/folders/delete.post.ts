// server/api/folders/delete.post.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService, FolderService } from '~~/server/utils/db'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  try {
    const { targetUserId } = await getMeAndTarget(event)
    const userId = Number(targetUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const { folderId } = await readBody(event)
    const id = Number(folderId)
    if (!Number.isInteger(id) || id < 1) {
      throw createError({ statusCode: 400, statusMessage: '非法的 folderId' })
    }

    const folderService = new FolderService(db)
    const fileService = new FileService(db)

    // 归属校验
    await folderService.assertOwned(userId, id)

    // 递归收集所有后代文件夹ID（含自身，每一跳都带 user_id）
    const ids = await folderService.listDescendantIds(userId, id)
    if (ids.length === 0) {
      // 理论上不会发生：至少包含自身
      return { success: true, message: '无需删除' }
    }

    // 在删除数据库前，先查出待删文件（用于COS删除）
    const filesToDelete = (await fileService.listByFolders(userId, ids)).filter((f) => !!f.fileKey)

    // COS 删除（如果配置了密钥且有文件需要删除）
    const config = useRuntimeConfig()
    let cosAttempted = false
    let cosDeleteAll = false

    if (
      filesToDelete.length > 0 &&
      config.tencentSecretId
    ) {
      cosAttempted = true
      try {
        const COS = (await import('cos-nodejs-sdk-v5')).default
        const cos = new COS({
          SecretId: config.tencentSecretId,
          SecretKey: config.tencentSecretKey,
        })

        const keys = filesToDelete.map((f) => ({ Key: f.fileKey }))
        const chunkSize = 1000
        let deletedCount = 0

        for (let i = 0; i < keys.length; i += chunkSize) {
          const batch = keys.slice(i, i + chunkSize)
          // Quiet: true 表示不返回逐个删除结果，若请求出错会直接走 err
          await new Promise((resolve, reject) => {
            cos.deleteMultipleObject(
              {
                Bucket: config.cosBucket,
                Region: config.cosRegion,
                Objects: batch,
                Quiet: true,
              },
              (err: any, data: any) => {
                if (err) {
                  console.error('COS batch delete error:', err)
                  reject(err)
                } else {
                  deletedCount += batch.length
                  resolve(data)
                }
              }
            )
          })
        }

        cosDeleteAll = deletedCount === keys.length
        if (cosDeleteAll) {
          console.log(`Successfully deleted ${deletedCount} file(s) from COS for user ${userId}`)
        } else {
          console.warn(`COS deletion may be partial: ${deletedCount}/${keys.length}`)
        }
      } catch (cosError: any) {
        console.error('Failed to delete files from COS during folder deletion:', cosError)
        cosDeleteAll = false
      }
    }

    // 先删文件，再删文件夹（手动级联，两条都带 user_id）
    await fileService.deleteOwnedMany(userId, filesToDelete.map((f) => f.id))
    await folderService.deleteOwned(userId, ids)

    // 重算用户存储用量
    await fileService.recalculateUsedStorage(userId)

    let message = '文件夹及其内容已删除'
    if (cosAttempted && !cosDeleteAll) {
      message = '文件夹及其内容已删除，但COS文件删除可能失败'
    }

    return { success: true, message }
  } catch (error: any) {
    console.error('Delete folder error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '删除文件夹失败' })
  }
})