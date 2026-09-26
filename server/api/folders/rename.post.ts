// server/api/folders/rename.post.ts
import { defineEventHandler, readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { FolderService } from '~~/server/utils/db'
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { normalizeFolderName } from '~~/server/utils/folders'

function isUniqueError(err: any) {
  return (
    err?.code === 'SQLITE_CONSTRAINT' ||
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE/i.test(err?.message || '') ||
    err?.code === 'ER_DUP_ENTRY'
  )
}

export default defineEventHandler(async (event) => {
  const { targetUserId } = await getMeAndTarget(event)
  const userId = Number(targetUserId)
  const db = getDb(event)

  const body = await readBody<{ folderId: number; newName: string }>(event)
  const folderId = Number(body?.folderId)
  const newName = normalizeFolderName((body?.newName || '').trim())

  if (!folderId || !newName) {
    throw createError({ statusCode: 400, statusMessage: 'folderId/newName 缺失' })
  }
  if (newName.length > 255) {
    throw createError({ statusCode: 400, statusMessage: '名称过长（最多255字符）' })
  }
  if (/[\\\/]/.test(newName) || newName === '.' || newName === '..') {
    throw createError({ statusCode: 400, statusMessage: '非法的文件夹名称' })
  }

  const folderService = new FolderService(db)

  // 归属校验，不存在与不属于本人统一 404
  await folderService.assertOwned(userId, folderId)

  try {
    // 即使 changes=0（同名或无变化）也当成功返回
    await folderService.updateName(userId, folderId, newName)
    return { success: true }
  } catch (err: any) {
    if (isUniqueError(err)) {
      throw createError({ statusCode: 409, statusMessage: '同一目录下已存在同名文件夹' })
    }
    throw createError({ statusCode: 500, statusMessage: err?.message || '重命名失败' })
  }
})