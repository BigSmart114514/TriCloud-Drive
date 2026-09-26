// server/api/files/rename.post.ts
import { defineEventHandler, readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { getMeAndTarget } from '~~/server/utils/auth-middleware'

function isUniqueError(err: any) {
  return (
    err?.code === 'SQLITE_CONSTRAINT' ||
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE/i.test(err?.message || '') ||
    err?.code === 'ER_DUP_ENTRY'
  )
}

export default defineEventHandler(async (event) => {
  //const user = await requireAuth(event)
  const {targetUserId} = await getMeAndTarget(event)
  const userId = Number(targetUserId)
  const db = getDb(event)

  const body = await readBody<{ fileId: number; newName: string }>(event)
  const fileId = Number(body?.fileId)
  const newName = (body?.newName || '').trim()

  if (!fileId || !newName) {
    throw createError({ statusCode: 400, statusMessage: 'fileId/newName 缺失' })
  }
  if (newName.length > 255) {
    throw createError({ statusCode: 400, statusMessage: '名称过长（最多255字符）' })
  }
  if (/[\\\/]/.test(newName)) {
    throw createError({ statusCode: 400, statusMessage: '文件名不可包含斜杠/反斜杠' })
  }

  const fileService = new FileService(db)

  // 归属校验，不存在与不属于本人统一 404
  await fileService.assertOwnedById(userId, fileId)

  try {
    await fileService.updateName(userId, fileId, newName)
    return { success: true }
  } catch (err: any) {
    if (isUniqueError(err)) {
      throw createError({ statusCode: 409, statusMessage: '当前文件夹内已存在同名文件' })
    }
    throw createError({ statusCode: 500, statusMessage: err?.message || '重命名失败' })
  }
})