import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService, FolderService } from '~~/server/utils/db'
import { resolveUniqueFilename } from '~~/server/utils/file'
import { userExpiredError, userNotFindError, dbConnectionError, upload403Error } from '~~/types/error'
import { DEFAULT_SHARE_MODE, PERM_WRITE } from '~~/types/share'
import { isExpired, nowSqlString } from '~~/server/utils/time'

export default defineEventHandler(async (event) => {
  // parseSqlDateTime / isExpired / nowSqlString 都搬到 server/utils/time.ts 了。
  // 这里原来三个都用**本地时区**方法（new Date(y, mo-1, …)、getFullYear()），
  // 两端一致所以过期判断自己看不出错，但和 DB 里其它 UTC 写入的数据不同源。

  function normalizeFolderId(input: any): number | null {
    if (input === undefined || input === null || input === '' || input === 'root' || input === '0' || input === 0) return null
    const n = Number(input)
    if (!Number.isInteger(n) || n < 1) throw createError({ statusCode: 400, message: '非法的 folderId' })
    return n
  }

  

  function buildName(base: string, ext: string, n: number): string {
    return n <= 1 ? `${base}${ext}` : `${base} (${n})${ext}`
  }

  try {
    //const user = await requireAuth(event)
    const { authUserId } = await getMeAndTarget(event)
    // 鉴权身份：useAdmin 时是属主，否则是我（只往我有 write 的目录里写）
    const authId = Number(authUserId)
    const body = await readBody(event)
    const { filename, safeFilename, fileKey, fileSize, fileUrl, contentType, overwrite } = body || {}
    const folderId = normalizeFolderId(body?.folderId ?? (event as any)?.context?.folderId)

    if (!filename || !fileKey || !fileUrl) throw createError({ statusCode: 400, message: '缺少必要的文件信息' })

    const size = Number(fileSize)
    if (!Number.isFinite(size) || size < 0) throw createError({ statusCode: 400, message: 'fileSize 参数无效' })

    const db = getDb(event)
    if (!db) throw dbConnectionError

    const fileService = new FileService(db)
    const folderService = new FolderService(db)

    // 目标目录必须对我有 write。原来只有 assertFolderOwned(userId)（要求 userId 拥有
    // 它），普通用户传 targetUserId=<属主> 就能往别人树里塞文件。根层是自己的根，放行。
    let userId = authId
    if (folderId !== null) {
      const dest = await folderService.findAccessibleById(authId, folderId, PERM_WRITE)
      userId = dest.userId
    }

    // 额度与过期一律按**属主**判定：文件落在谁的树里，就占谁的容量、算谁过期。
    const userRow: any = await db.prepare('SELECT expire_at FROM users WHERE id = ?').bind(userId).first()
    if (!userRow) throw userNotFindError
    if (isExpired(userRow.expire_at)) throw userExpiredError

    await db.prepare('SAVEPOINT upload_tx').bind().run()
    try {
      if (overwrite === true) {
        const exist = await fileService.findByName(userId, folderId, filename)

        if (exist?.id) {
          const oldSize = exist.fileSize
          const delta = size - oldSize

          const upd = await db.prepare(`
            UPDATE users
            SET usedStorage = usedStorage + ?
            WHERE id = ?
              AND (maxStorage = 0 OR usedStorage + ? <= maxStorage)
              AND (expire_at IS NULL OR expire_at > ?)
          `).bind(delta, userId, delta, nowSqlString()).run()
          const changes = (upd as any)?.meta?.changes ?? 0
          if (changes !== 1) {
            await db.prepare('ROLLBACK TO upload_tx').bind().run()
            await db.prepare('RELEASE upload_tx').bind().run()
            throw upload403Error
          }

          await fileService.updateContent(userId, exist.id, {
            fileKey,
            fileSize: size,
            fileUrl,
            contentType: contentType || 'application/octet-stream'
          })

          const file = await fileService.findOwnedById(userId, exist.id)
          await db.prepare('RELEASE upload_tx').bind().run()
          return { success: true, statusMessage: '文件覆盖成功', file }
        }
      }

      let { name: finalName, base, ext, nextN } = await resolveUniqueFilename(db, userId, folderId, filename)

      const upd = await db.prepare(`
        UPDATE users
        SET usedStorage = usedStorage + ?
        WHERE id = ?
          AND (maxStorage = 0 OR usedStorage + ? <= maxStorage)
          AND (expire_at IS NULL OR expire_at > ?)
      `).bind(size, userId, size, nowSqlString()).run()
      const changes = (upd as any)?.meta?.changes ?? 0
      if (changes !== 1) {
        await db.prepare('ROLLBACK TO upload_tx').bind().run()
        await db.prepare('RELEASE upload_tx').bind().run()
        throw upload403Error
      }

      let file: any | null = null
      const maxRetry = 10
      for (let attempt = 0; attempt < maxRetry; attempt++) {
        try {
          file = await db.prepare(`
            INSERT INTO files (user_id, folder_id, filename, file_key, file_size, file_url, content_type, Shared)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING *
          `).bind(
            userId,
            folderId,
            finalName,
            fileKey,
            size,
            fileUrl,
            contentType || 'application/octet-stream',
            DEFAULT_SHARE_MODE
          ).first()
          break
        } catch (e: any) {
          const msg = String(e?.message || e)
          if (msg.includes('UNIQUE') && msg.includes('files')) {
            nextN += 1
            finalName = buildName(base, ext, nextN)
            continue
          }
          await db.prepare('ROLLBACK TO upload_tx').bind().run()
          await db.prepare('RELEASE upload_tx').bind().run()
          throw e
        }
      }

      if (!file) {
        await db.prepare('ROLLBACK TO upload_tx').bind().run()
        await db.prepare('RELEASE upload_tx').bind().run()
        throw createError({ statusCode: 500, message: '保存失败：重名重试次数过多' })
      }

      await db.prepare('RELEASE upload_tx').bind().run()
      return { success: true, statusMessage: '文件记录保存成功', file }
    } catch (txErr) {
      try { await db.prepare('ROLLBACK TO upload_tx').bind().run(); await db.prepare('RELEASE upload_tx').bind().run() } catch {}
      throw txErr
    }
  } catch (error: any) {
    console.error('Save file record error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '保存文件记录失败' })
  }
})