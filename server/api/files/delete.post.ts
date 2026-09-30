import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { dbConnectionError } from '~~/types/error'
import { PERM_DELETE } from '~~/types/share'

export default defineEventHandler(async (event) => {
  try {
    // 验证用户认证
    //const user = await requireAuth(event)
    // 权限判定用 authUserId：useAdmin 时它是属主（等同原版的纯归属），
    // 否则是我（只碰分享权限够得着的）
    const { authUserId } = await getMeAndTarget(event)
    const userId = Number(authUserId)

    const { fileId } = await readBody(event)

    if (!fileId) {
      throw createError({
        statusCode: 400,
        message: '文件ID不能为空'
      })
    }

    // 获取运行时配置
    const config = useRuntimeConfig()

    // 获取数据库连接
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const fileService = new FileService(db)

    // 所有者或被授权人（需要删除权限）
    const fileRecord = await fileService.findAccessibleById(userId, Number(fileId), PERM_DELETE)
    const ownerId = fileRecord.userId

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
    await fileService.deleteOwned(ownerId, Number(fileId))

    // 重算法：算的是属主的用量，被授权人代删时不能记到自己头上
    await fileService.recalculateUsedStorage(ownerId)

    // 查询最新 usedStorage 以便返回给前端（可用于即时更新UI）
    /*const userAfter = await db
      .prepare('SELECT usedStorage FROM users WHERE id = ?')
      .bind(user.userId)
      .first()*/

    return {
      success: true,
      statusMessage: cosDeleteSuccess ? '文件删除成功' : '文件记录已删除，但COS文件删除可能失败',
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
      message: '删除文件失败'
    })
  }
})