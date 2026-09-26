// server/api/folders/manifest.get.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FolderService } from '~~/server/utils/db'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  const { targetUserId } = await getMeAndTarget(event)
  const userId = Number(targetUserId)
  const q = getQuery(event)
  const folderId = Number(q.folderId)

  if (!Number.isFinite(folderId)) {
    throw createError({ statusCode: 400, statusMessage: 'folderId 无效' })
  }

  const db = getDb(event)
  if (!db) throw dbConnectionError

  const folderService = new FolderService(db)

  // 属主直接放行；被授权人需要对整个目录有读权限
  const folder = await folderService.assertReadable(userId, folderId)
  // 子树里的行天然都属于属主，用属主 id 继续过滤，访客也能拿到完整清单
  const subtreeOwnerId = folder?.userId ?? userId

  // 递归收集文件（带相对路径 relDir）
  const files = await folderService.listSubtreeManifest(subtreeOwnerId, folderId)
  const totalBytes = files.reduce((s, f) => s + Number(f.fileSize || 0), 0)

  // 预检（不预占）：检查总大小是否会超出下载额度
  const quotaRow = await db
    .prepare('SELECT COALESCE(usedDownload, 0) AS usedDownload, COALESCE(maxDownload, 0) AS maxDownload FROM users WHERE id = ?')
    .bind(userId)
    .first()

  const used = Number(quotaRow?.usedDownload ?? 0)
  const max = Number(quotaRow?.maxDownload ?? 0)
  const unlimited = max <= 0
  const remaining = unlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, max - used)
  const allowed = unlimited || used + totalBytes <= max
  const exceedBytes = allowed ? 0 : Math.max(0, used + totalBytes - max)

  return {
    success: true,
    folder: { id: folder?.id ?? folderId, name: folder?.name ?? '' },
    files, // [{ id, filename, fileKey, fileSize, relDir }]
    totals: {
      count: files.length,
      bytes: totalBytes
    },
    // 新增：仅用于提示的总量预检，不进行额度预占
    precheck: {
      allowed,                 // true=总量不超；false=总量会超
      unlimited,               // true=不限流
      requiredBytes: totalBytes,
      remainingBytes: unlimited ? -1 : remaining,
      exceedBytes,             // 将超出的字节数
      usedDownload: used,
      maxDownload: max
    }
  }
})