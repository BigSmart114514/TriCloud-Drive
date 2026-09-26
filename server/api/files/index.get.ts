// server/api/files/index.get.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { placeholders } from '~~/server/utils/functions'
import { getQuery } from 'h3'

export default defineEventHandler(async (event) => {
  try {
    //const me = await requireAuth(event) // 默认只拿 userId
    const db = getDb(event)
    if (!db) throw createError({ statusCode: 500, statusMessage: '数据库连接失败' })

    const { folderId: rawFolderId, targetUserId: rawTargetUserId } = getQuery(event) as {
      folderId?: string
      targetUserId?: string
    }
    const { targetUserId } = await getMeAndTarget(event)

    let effectiveUserId = targetUserId

    // 解析 folderId
    let folderId: number | null = null
    if (rawFolderId && rawFolderId !== 'root' && rawFolderId !== '0') {
      const parsed = Number(rawFolderId)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw createError({ statusCode: 400, statusMessage: '非法的 folderId' })
      }
      folderId = parsed

      // 校验目录归属
      const check = await db
        .prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?')
        .bind(folderId, effectiveUserId)
        .all()
      if (!check.results || check.results.length === 0) {
        throw createError({ statusCode: 404, statusMessage: '文件夹不存在或无权限' })
      }
    }

    // 查询子文件夹
    const foldersRes = folderId === null
      ? await db
          .prepare(`
            SELECT id, name, parent_id AS parentId, created_at AS createdAt
            FROM folders
            WHERE user_id = ? AND parent_id IS NULL
            ORDER BY name COLLATE NOCASE ASC
          `)
          .bind(effectiveUserId)
          .all()
      : await db
          .prepare(`
            SELECT id, name, parent_id AS parentId, created_at AS createdAt
            FROM folders
            WHERE user_id = ? AND parent_id = ?
            ORDER BY name COLLATE NOCASE ASC
          `)
          .bind(effectiveUserId, folderId)
          .all()

    // 查询文件
    const filesRes = folderId === null
      ? await db
          .prepare(`
            SELECT
              id, filename, folder_id AS folderId,
              file_key AS fileKey, file_size AS fileSize,
              file_url AS fileUrl, content_type AS contentType,
              created_at AS createdAt,
              Shared, IsPublic
            FROM files
            WHERE user_id = ? AND folder_id IS NULL
            ORDER BY created_at DESC
          `)
          .bind(effectiveUserId)
          .all()
      : await db
          .prepare(`
            SELECT
              id, filename, folder_id AS folderId,
              file_key AS fileKey, file_size AS fileSize,
              file_url AS fileUrl, content_type AS contentType,
              created_at AS createdAt,
              Shared, IsPublic
            FROM files
            WHERE user_id = ? AND folder_id = ?
            ORDER BY created_at DESC
          `)
          .bind(effectiveUserId, folderId)
          .all()

    const files = (filesRes.results || []) as any[]
    const accessMap = await loadAllowedUsers(db, files.map((file) => file.id))

    return {
      success: true,
      currentFolderId: folderId,
      folders: foldersRes.results || [],
      files: files.map((file) => ({
        ...file,
        Shared: !!(file.Shared === true || file.Shared === 1),
        IsPublic: !!(file.IsPublic === true || file.IsPublic === 1),
        allowedUsers: accessMap.get(Number(file.id)) || []
      }))
    }
  } catch (error: any) {
    console.error('Get items error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '获取列表失败' })
  }
})

// 一次查询取出本批文件的授权人员，避免逐文件查询
async function loadAllowedUsers(db: any, fileIds: number[]) {
  const map = new Map<number, number[]>()
  if (!fileIds.length) return map

  const res = await db
    .prepare(`
      SELECT file_id AS fileId, user_id AS userId
      FROM file_access
      WHERE file_id IN (${placeholders(fileIds.length)})
      ORDER BY user_id ASC
    `)
    .bind(...fileIds)
    .all()
    .catch(() => null)

  for (const row of res?.results || []) {
    const id = Number(row.fileId)
    const list = map.get(id) || []
    list.push(Number(row.userId))
    map.set(id, list)
  }
  return map
}