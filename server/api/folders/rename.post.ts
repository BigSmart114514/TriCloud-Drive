// server/api/folders/rename.post.ts
import { defineEventHandler, readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { FolderService } from '~~/server/utils/db'
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { normalizeFolderName } from '~~/server/utils/folders'
import { PERM_WRITE } from '~~/types/share'

function isUniqueError(err: any) {
  return (
    err?.code === 'SQLITE_CONSTRAINT' ||
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE/i.test(err?.message || '') ||
    err?.code === 'ER_DUP_ENTRY'
  )
}

export default defineEventHandler(async (event) => {
  const { authUserId } = await getMeAndTarget(event)
  const userId = Number(authUserId)
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

  // 需要 write 权限：属主放行，被授权人凭分享权限也能改名。
  // 原来只有 assertOwned(userId)（要求 userId 本人拥有），
  // 普通用户传 targetUserId=<属主> 就能改别人目录名。
  // 返回的 row 带真实属主，写入仍按属主限定。
  const target = await folderService.findAccessibleById(userId, folderId, PERM_WRITE)

  try {
    // 即使 changes=0（同名或无变化）也当成功返回
    await folderService.updateName(target.userId, folderId, newName)
    return { success: true }
  } catch (err: any) {
    if (isUniqueError(err)) {
      throw createError({ statusCode: 409, statusMessage: '同一目录下已存在同名文件夹' })
    }
    throw createError({ statusCode: 500, statusMessage: err?.message || '重命名失败' })
  }
})