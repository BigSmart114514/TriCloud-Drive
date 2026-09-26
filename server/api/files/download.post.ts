import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import crypto from 'crypto'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { dbConnectionError } from '~~/types/error'

// 生成 CDN 鉴权 URL (TypeA)
const generateCDNUrl = (
  fileKey: string,
  cdnDomain: string,
  primaryKey: string,
  backupKey: string,
  ttl: number,
  authParam: string,
  filename?: string
) => {
  const timestamp = Math.floor(Date.now() / 1000) + ttl
  const path = `/${fileKey}`
  const rand = Math.floor(Math.random() * 1000000).toString()
  const uid = 0

  const secret = primaryKey
  const authString = `${path}-${timestamp}-${rand}-${uid}-${secret}`
  const sign = crypto.createHash('md5').update(authString).digest('hex')

  const authValue = `${timestamp}-${rand}-${uid}-${sign}`

  const params = new URLSearchParams()
  params.set(authParam, authValue)
  if (filename) {
    params.set('response-content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
  }

  return `https://${cdnDomain}${path}?${params.toString()}`
}

// 兼容 D1 / sqlite3 的受影响行数
const getAffectedRows = (res: any) =>
  res?.meta?.changes ?? res?.meta?.rowsWritten ?? res?.meta?.rowsAffected ?? 0

export default defineEventHandler(async (event) => {
  try {
    //const user = await requireAuth(event)
    const { targetUserId } = await getMeAndTarget(event)
    const userId = Number(targetUserId)

    const { fileKey, filename } = await readBody(event)

    if (!fileKey) {
      throw createError({ statusCode: 400, statusMessage: '文件路径不能为空' })
    }

    const config = useRuntimeConfig()
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const fileService = new FileService(db)

    // 归属校验：这里按 file_key 授权，不是按 id
    const fileRecord = await fileService.assertOwnedByKey(userId, fileKey)

    const fileSize = fileRecord.fileSize

    // ========== 并发安全：原子预占下载额度 ==========
    // 逻辑：直接用一条 UPDATE 做 check+incr。
    // 约定：maxDownload <= 0 表示不限流量，但仍会累计 usedDownload（如不需要可自行改为不累计）。
    const reserveRes = await db
      .prepare(`
        UPDATE users
        SET usedDownload = COALESCE(usedDownload, 0) + ?
        WHERE id = ?
          AND (
            COALESCE(maxDownload, 0) <= 0
            OR COALESCE(usedDownload, 0) + ? <= COALESCE(maxDownload, 0)
          )
      `)
      .bind(fileSize, userId, fileSize)
      .run()

    const reserved = getAffectedRows(reserveRes) > 0
    if (!reserved) {
      throw createError({
        statusCode: 403,
        statusMessage: '下载额度不足：下载该文件将超过您的下载流量上限'
      })
    }
    // ========== 原子预占结束 ==========

    // 后续如果出现异常，尝试回滚预占
    const safeFail = async (err: any) => {
      try {
        await db
          .prepare('UPDATE users SET usedDownload = COALESCE(usedDownload, 0) - ? WHERE id = ?')
          .bind(fileSize, userId)
          .run()
      } catch (_) {
        // 忽略回滚失败
      }
      throw err
    }

    try {
      if (config.cdnEnabled && config.cdnDomain) {
        const cdnUrl = generateCDNUrl(
          fileKey,
          config.cdnDomain,
          config.cdnAuthKeyPrimary,
          config.cdnAuthKeyBackup,
          config.cdnAuthTtl,
          config.cdnAuthParam,
          filename
        )

        return {
          success: true,
          data: {
            downloadUrl: cdnUrl,
            filename: filename || fileRecord.filename,
            fileSize: fileRecord.fileSize,
            expiresAt: new Date(Date.now() + config.cdnAuthTtl * 1000).toISOString(),
            useCDN: true
          }
        }
      }

      // 无 CDN：返回 COS 直链
      const cosUrl = `https://${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com/${fileKey}`
      return {
        success: true,
        data: {
          downloadUrl: cosUrl,
          filename: filename || fileRecord.filename,
          fileSize: fileRecord.fileSize,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          useCDN: false
        }
      }
    } catch (err: any) {
      await safeFail(err)
    }
  } catch (error: any) {
    console.error('Generate download signature error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '生成下载签名失败' })
  }
})