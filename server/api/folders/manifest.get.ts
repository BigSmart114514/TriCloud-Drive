// server/api/folders/manifest.get.ts
//
// 整包下载的清单。三个改动都是修 bug：
//   1. 只返回**调用者真能下载**的文件。以前整棵子树原样发出，等于把没权限的
//      文件名和 file_key（真实存储路径）也交出去，而且前端逐个下载时第一个
//      缺下载位的文件就 403，整个 zip 中途作废。
//   2. 判定用 authUserId 而不是 targetUserId。以前非管理员传
//      ?targetUserId=5 就能拿到**用户 5** 视角的清单。
//   3. 额度预检查的是**真正会被扣的人**。以前查 targetUserId，实际预占记的是
//      文件属主，于是提示「不会超限」点下去却被拒。
import { getMeAndTarget, optionalAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService, FolderService } from '~~/server/utils/db'
import type { ManifestFile } from '~~/server/utils/db'
import { quotaExceededMessage, resolveQuotaOwnerId } from '~~/server/utils/quota'
import {
  linkGrantsFolder,
  linkNotActiveMessage,
  listSubtreeByLink,
  resolveLinkTarget
} from '~~/server/utils/share-link'
import { dbConnectionError } from '~~/types/error'
import { normalizeShareLink } from '~~/types/share'
import { getQuery } from 'h3'

function parseFolderId(raw: any): number {
  const folderId = Number(raw)
  if (!Number.isInteger(folderId) || folderId < 1) {
    throw createError({ statusCode: 400, message: 'folderId 无效' })
  }
  return folderId
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event) as { folderId?: string; link?: string }
  const folderId = parseFolderId(q?.folderId)

  const db = getDb(event)
  if (!db) throw dbConnectionError

  const folderService = new FolderService(db)
  const fileService = new FileService(db)

  let files: ManifestFile[]
  let skipped: number
  let folderName: string
  /** 这次下载记在谁头上 —— 必须与 download.post.ts 用同一个函数算出来 */
  let quotaOwnerId: number
  /** 谁点的这次下载。链接访问没有操作者 */
  let actorId: number | null
  let adminMode = false

  // —— 分享链接：匿名，与登录态无关 ——
  const link = normalizeShareLink(q?.link)
  if (link) {
    // 先 resolveLinkTarget 拿到属主：链接覆盖判定和清单都靠它圈 user_id 范围
    const target = await resolveLinkTarget(db, link)
    if (!(await linkGrantsFolder(db, link, folderId))) {
      // 死链提示分访客/属主两套（见 linkNotActiveMessage）。
      // 这里匿名可调，身份用 optionalAuth 取，拿不到就走访客口径。
      const session = await optionalAuth(event)
      throw createError({
        statusCode: 404,
        message: linkNotActiveMessage(session ? Number(session.userId) : null, target.ownerId)
      })
    }
    const scoped = await listSubtreeByLink(db, target.ownerId, folderId)
    files = scoped.files
    skipped = scoped.skipped
    folderName = (await folderService.findOwnedById(target.ownerId, folderId))?.name ?? ''
    quotaOwnerId = resolveQuotaOwnerId(false, 0, target.ownerId)
    actorId = null
  } else {
    // —— 登录路径 ——
    // 判定一律用 authUserId：useAdmin 时它是属主，退化成纯归属判定；
    // 否则是我，走分享权限。用 targetUserId 会让「指定别人」变成提权。
    const { authUserId, adminMode: am, me } = await getMeAndTarget(event)
    const visitorId = Number(authUserId)
    adminMode = am

    // 属主直接放行；被授权人需要对整个目录有读权限
    const folder = await folderService.assertReadable(visitorId, folderId)
    // 子树里的行天然都属于属主，用属主 id 继续过滤
    const subtreeOwnerId = folder?.userId ?? visitorId
    folderName = folder?.name ?? ''

    const scoped = await fileService.listDownloadableSubtree(visitorId, subtreeOwnerId, folderId)
    files = scoped.files
    skipped = scoped.skipped

    quotaOwnerId = resolveQuotaOwnerId(am, Number(me.userId), subtreeOwnerId)
    actorId = Number(me.userId)
  }

  const totalBytes = files.reduce((s, f) => s + Number(f.fileSize || 0), 0)

  // 预检（不预占）：检查总大小是否会超出**真正会被扣的那个人的**下载额度。
  // 与 download.post.ts 的预占条件保持一致，否则这里说「不会超」点下去却被拒。
  const quotaRow = await db
    .prepare('SELECT COALESCE(usedDownload, 0) AS usedDownload, COALESCE(maxDownload, 0) AS maxDownload FROM users WHERE id = ?')
    .bind(quotaOwnerId)
    .first()

  const used = Number(quotaRow?.usedDownload ?? 0)
  const max = Number(quotaRow?.maxDownload ?? 0)
  const unlimited = max <= 0
  const remaining = unlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, max - used)
  const allowed = unlimited || used + totalBytes <= max
  const exceedBytes = allowed ? 0 : Math.max(0, used + totalBytes - max)

  return {
    success: true,
    folder: { id: folderId, name: folderName },
    files, // [{ id, filename, fileKey, fileSize, relDir, folderId, Shared, IsPublic }]
    totals: {
      count: files.length,
      bytes: totalBytes
    },
    /** 因权限/边界被排除掉的文件数。前端要说清「跳过 N 个」，不能让人以为目录本来就是空的 */
    skipped,
    // 仅用于提示的总量预检，不进行额度预占
    precheck: {
      allowed,                 // true=总量不超；false=总量会超
      unlimited,               // true=不限流
      requiredBytes: totalBytes,
      remainingBytes: unlimited ? -1 : remaining,
      exceedBytes,             // 将超出的字节数
      usedDownload: used,
      maxDownload: max,
      // 这两个让调用方能解释「这个额度是谁的」——分享链接场景下它不是访问者的
      quotaOwnerId,
      /** 不 allowed 时的现成文案，与真正被拒时的提示同源（同一个函数出来的） */
      message: allowed
        ? null
        : await quotaExceededMessage(db, quotaOwnerId, actorId, adminMode)
    }
  }
})
