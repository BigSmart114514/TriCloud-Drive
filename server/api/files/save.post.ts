import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService, FolderService } from '~~/server/utils/db'
import { resolveUniqueFilename } from '~~/server/utils/file'
import { dedupeName } from '~~/server/utils/naming'
import { deleteCosObject } from '~~/server/utils/cos'
import { assertFileKeyOwner } from '~~/server/utils/file-key'
// upload403Error 不再由预占失败抛出 —— 失败原因现在分得出是哪一层不够，
// 走 quotaFailMessage 给对应文案（见下面两处 reserveStorage）。
import { userExpiredError, userNotFindError, dbConnectionError } from '~~/types/error'
import { DEFAULT_SHARE_MODE, PERM_WRITE } from '~~/types/share'
import { quotaFailMessage } from '~~/server/utils/quota'
import { chainExpired, reserveStorage, resolveQuotaChain } from '~~/server/utils/sub-account'

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

    /**
     * fileKey 必须落在属主的命名空间里。
     *
     * fileKey 是客户端原样送进来的（COS 上真实存在的对象路径），而服务端只在
     * /api/upload/credentials **生成**过它、从不复验 —— 少一步校验，攻击者就能
     * 给自己的一条文件记录填上受害者的路径。
     *
     * 比的是 **userId（解析出来的属主）而不是 authId**：useAdmin 场景下文件是
     * 写进别人的树（userId = dest.userId），拿 authId 比会把管理员自己的合法
     * 上传也挡掉。
     */
    assertFileKeyOwner(fileKey, userId)

    // 额度与过期一律按**属主**判定：文件落在谁的树里，就占谁的容量、算谁过期。
    const userRow: any = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
    if (!userRow) throw userNotFindError

    /**
     * 过期判定按**整条链**：属主是子账户时，主账号套餐过期也会挡住他上传。
     * 逐层判断在 chainExpired 里，各判各的 expire_at —— 子账户自己过期不影响
     * 兄弟，主账号过期则整条池冻住。
     */
    const quotaChain = await resolveQuotaChain(db, userId)
    const expiredOn = await chainExpired(db, quotaChain)
    if (expiredOn.self) throw userExpiredError
    if (expiredOn.parent) {
      throw createError({
        statusCode: 403,
        message: await quotaFailMessage(db, 'expired_parent', userId, null, false)
      })
    }

    await db.prepare('SAVEPOINT upload_tx').bind().run()
    try {
      if (overwrite === true) {
        const exist = await fileService.findByName(userId, folderId, filename)

        if (exist?.id) {
          const oldSize = exist.fileSize
          const delta = size - oldSize

          // delta 可以是负数（覆盖更小的文件会释放容量）。reserveStorage
          // 把 delta 原样带进池的判定，于是「池快满了但这次是缩小」不会被误拒。
          const fail = await reserveStorage(db, quotaChain, delta)
          if (fail) {
            await db.prepare('ROLLBACK TO upload_tx').bind().run()
            await db.prepare('RELEASE upload_tx').bind().run()
            // 事务回滚了，数据库仍指向**旧** fileKey；而这次新传上去的那个对象
            // 没人认领 —— 桶里多一份字节，用户看不见、也删不掉。这里主动清掉。
            // 清不掉也不抛：抛了会盖掉上面那个真正的配额原因。
            await deleteCosObject(fileKey)
            throw createError({
              statusCode: 403,
              message: await quotaFailMessage(db, fail, userId, null, false)
            })
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

      const fail = await reserveStorage(db, quotaChain, size)
      if (fail) {
        await db.prepare('ROLLBACK TO upload_tx').bind().run()
        await db.prepare('RELEASE upload_tx').bind().run()
        // 同上：字节已经在 COS 里了，数据库这侧没记录。清掉，别留孤儿。
        await deleteCosObject(fileKey)
        throw createError({
          statusCode: 403,
          message: await quotaFailMessage(db, fail, userId, null, false)
        })
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
            finalName = dedupeName(base, ext, nextN)
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