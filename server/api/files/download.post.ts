import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import crypto from 'crypto'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import type { OwnedFile } from '~~/server/utils/db'
import { quotaExceededMessage, resolveQuotaOwnerId } from '~~/server/utils/quota'
import { findFileByLink } from '~~/server/utils/share-link'
import { dbConnectionError } from '~~/types/error'
import { normalizeShareLink, PERM_DOWNLOAD } from '~~/types/share'
import { getQuery } from 'h3'

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
    /**
     * 分享链接优先，**排他**：带了 link 就只走链接逻辑，完全不看登录态。
     *
     * 「排他」是有意的 —— 反过来（两条路都走、或者登录态优先）的话，一个
     * 登录用户拿着别人的链接来下载，会走自己那份权限，等于链接变成了
     * 「绕过授权的旁路」。这里保证链接永远只能给出 LINK_PERMISSION，
     * 不可能因为恰好有 cookie 就多拿到什么。
     *
     * 代价：属主自己用链接来下载也只拿到读+下载。属主本来就有全权，
     * 所以只是少几个按钮，不影响使用。
     */
    const link = normalizeShareLink((getQuery(event) as any)?.link)

    // 不带 link 才认证。getMeAndTarget 内部会 readBody，所以必须在下面那次
    // readBody 之前调用 —— 顺序照旧，不动。
    const session = link ? null : await getMeAndTarget(event)

    // body 可能整个不存在（空 body / body 是 null / 没有 Content-Type）。
    // 直接解构 undefined 会抛 TypeError，被最外层 catch 兜成 500 —— 客户端格式错
    // 不该得到服务端错误。`?? {}` 把它变成「字段缺失」，走下面那句 400。
    const { fileKey, filename } = (await readBody(event)) ?? {}

    if (!fileKey) {
      throw createError({ statusCode: 400, message: '文件路径不能为空' })
    }

    const config = useRuntimeConfig()
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const fileService = new FileService(db)

    let fileRecord: OwnedFile
    // 额度记在谁头上，规则见 server/utils/quota.ts 的 resolveQuotaOwnerId。
    let quotaOwnerId: number
    // 谁在点这个下载。分享链接没有操作者 —— 拿链接的人没有身份，记 null。
    let actorId: number | null

    if (link) {
      fileRecord = await findFileByLink(db, fileService, link, fileKey)
      quotaOwnerId = resolveQuotaOwnerId(false, 0, fileRecord.userId)
      actorId = null
    } else {
      const { authUserId, adminMode, me } = session!
      // 归属或授权：所有者、被授权人（含从父文件夹继承的）都可下载
      //
      // 要的是 PERM_DOWNLOAD 而不是 PERM_READ：预览走的就是这个接口（前端
      // FilePreviewer 调 FilesService.downloadSign 拿签名），一样扣下载流量，
      // 所以「能预览」和「能下载」是同一件事，由同一个位管。
      fileRecord = await fileService.findAccessibleByKey(
        Number(authUserId),
        fileKey,
        PERM_DOWNLOAD,
        // 默认文案是「该文件的权限不足」，在下载场景会让人困惑（明明能看）。
        // 说清楚是下载/预览这一项没给。
        '无权下载该文件：预览也走下载接口（会消耗下载流量），需要「下载」权限'
      )
      quotaOwnerId = resolveQuotaOwnerId(adminMode, Number(me.userId), fileRecord.userId)
      actorId = Number(me.userId)
    }

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
      .bind(fileSize, quotaOwnerId, fileSize)
      .run()

    const reserved = getAffectedRows(reserveRes) > 0
    if (!reserved) {
      throw createError({
        statusCode: 403,
        message: await quotaExceededMessage(db, quotaOwnerId, actorId, session?.adminMode === true)
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