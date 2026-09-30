import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import crypto from 'crypto'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { dbConnectionError } from '~~/types/error'
import { PERM_READ } from '~~/types/share'

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

/**
 * 下载额度不足时的提示。
 *
 * 额度记在 quotaOwnerId 头上，而这个人不一定是操作者，所以文案不能说「您的」：
 *
 *   自己              → 记自己，用「您」
 *   别人的文件        → 记文件属主，名字要点出来，否则用户会去查自己的额度
 *   管理员代管        → 记管理员自己，「您」是对的，但要说明代的是谁
 */
async function quotaExceededMessage(
  db: any,
  quotaOwnerId: number,
  actorId: number,
  adminMode: boolean
): Promise<string> {
  const row = (await db
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(quotaOwnerId)
    .first()) as { username?: string } | null
  const name = row?.username || `用户 ${quotaOwnerId}`

  if (quotaOwnerId === actorId) {
    return '下载额度不足：下载该文件将超过您的下载流量上限'
  }
  if (adminMode) {
    return `下载额度不足：代「${name}」下载会计入您的下载流量，已超过您的上限`
  }
  return `下载额度不足：该文件属于「${name}」，下载它消耗的是对方的下载流量，且会超过对方的上限`
}

export default defineEventHandler(async (event) => {
  try {
    //const user = await requireAuth(event)
    const { authUserId, adminMode, me } = await getMeAndTarget(event)
    const userId = Number(authUserId)

    const { fileKey, filename } = await readBody(event)

    if (!fileKey) {
      throw createError({ statusCode: 400, message: '文件路径不能为空' })
    }

    const config = useRuntimeConfig()
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const fileService = new FileService(db)

    // 归属或授权：所有者、被授权人（含从父文件夹继承的）都可下载
    const fileRecord = await fileService.findAccessibleByKey(userId, fileKey, PERM_READ)

    const fileSize = fileRecord.fileSize

    // 额度记在谁头上，分两种：
    //
    //   管理员代管（adminMode）→ 记管理员自己（me.userId）。代管是「我去看你的东西」，
    //     花的是我自己的带宽，不该让你替我付。原来记的是 authUserId（= targetUserId），
    //     等于你被浏览一次就掉额度，而你根本没感知。
    //
    //   普通用户 → 记文件属主（fileRecord.userId）。文件是从谁的配额里出的就记谁，
    //     这样属主能看到自己的流量在被谁消耗。
    const quotaOwnerId = adminMode ? Number(me.userId) : Number(fileRecord.userId)

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
      .bind(fileSize, quotaOwnerId, fileSize)
      .run()

    const reserved = getAffectedRows(reserveRes) > 0
    if (!reserved) {
      throw createError({
        statusCode: 403,
        message: await quotaExceededMessage(db, quotaOwnerId, Number(me.userId), adminMode)
      })
    }
    // ========== 原子预占结束 ==========

    // 后续如果出现异常，尝试回滚预占
    const safeFail = async (err: any) => {
      try {
        await db
          .prepare('UPDATE users SET usedDownload = COALESCE(usedDownload, 0) - ? WHERE id = ?')
          .bind(fileSize, quotaOwnerId)
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
    throw createError({ statusCode: 500, message: '生成下载签名失败' })
  }
})