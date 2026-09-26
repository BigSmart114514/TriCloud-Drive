import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  try {
    // 验证用户认证
    //const user = await requireAuth(event)
    const { targetUserId } = await getMeAndTarget(event)
    const userId = Number(targetUserId)

    const { fileId } = await readBody(event)

    if (!fileId) {
      throw createError({
        statusCode: 400,
        statusMessage: '文件ID不能为空'
      })
    }

    // 获取运行时配置
    const config = useRuntimeConfig()

    // 获取数据库连接
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const fileService = new FileService(db)

    // 归属校验：非本人文件一律 404，不区分「不存在」与「无权限」
    const fileRecord = await fileService.assertOwnedById(userId, Number(fileId))

    // 如果配置了腾讯云密钥，则删除COS中的文件
    let cosDeleteSuccess = false
    if (
      config.tencentSecretId &&
      config.tencentSecretKey &&
      config.tencentSecretId !== 'your_secret_id_here' &&
      config.tencentSecretKey !== 'your_secret_key_here'
    ) {
      try {
        // 使用腾讯云COS Node.js SDK删除文件
        const COS = (await import('cos-nodejs-sdk-v5')).default

        const cos = new COS({
          SecretId: config.tencentSecretId,
          SecretKey: config.tencentSecretKey,
        })

        // 删除COS中的文件
        await new Promise((resolve, reject) => {
          cos.deleteObject(
            {
              Bucket: config.cosBucket,
              Region: config.cosRegion,
              Key: fileRecord.fileKey,
            },
            (err: any, data: any) => {
              if (err) {
                console.error('COS delete error:', err)
                reject(err)
              } else {
                console.log(`Successfully deleted file from COS: ${fileRecord.fileKey}`)
                console.log('COS delete response:', data)
                resolve(data)
              }
            }
          )
        })

        cosDeleteSuccess = true
      } catch (cosError: any) {
        console.error('Failed to delete file from COS:', cosError)
        // 注意：即使COS删除失败，我们仍然继续删除数据库记录并重算用量
        cosDeleteSuccess = false
      }
    }

    // 从数据库中删除文件记录
    await fileService.deleteOwned(userId, Number(fileId))

    // 重算法：根据该用户当前files总和重算 usedStorage
    await fileService.recalculateUsedStorage(userId)

    // 查询最新 usedStorage 以便返回给前端（可用于即时更新UI）
    /*const userAfter = await db
      .prepare('SELECT usedStorage FROM users WHERE id = ?')
      .bind(user.userId)
      .first()*/

    return {
      success: true,
      message: cosDeleteSuccess ? '文件删除成功' : '文件记录已删除，但COS文件删除可能失败',
      cosDeleted: cosDeleteSuccess,
      deletedFile: {
        id: fileRecord.id,
        filename: fileRecord.filename,
        fileKey: fileRecord.fileKey,
      },
      //usedStorage: userAfter?.usedStorage ?? null,
    }
  } catch (error: any) {
    console.error('Delete file error:', error)

    if (error.statusCode) {
      throw error
    }

    throw createError({
      statusCode: 500,
      statusMessage: '删除文件失败'
    })
  }
})