// server/api/files/rename.post.ts
import { defineEventHandler, readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
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
  //const user = await requireAuth(event)
  const {authUserId} = await getMeAndTarget(event)
  const userId = Number(authUserId)
  const db = getDb(event)

  const body = await readBody<{ fileId: number; newName: string }>(event)
  const fileId = Number(body?.fileId)
  const newName = (body?.newName || '').trim()

  if (!fileId || !newName) {
    throw createError({ statusCode: 400, message: 'fileId/newName 缺失' })
  }
  if (newName.length > 255) {
    throw createError({ statusCode: 400, message: '名称过长（最多255字符）' })
  }
  if (/[\\\/]/.test(newName)) {
    throw createError({ statusCode: 400, message: '文件名不可包含斜杠/反斜杠' })
  }

  const fileService = new FileService(db)

  // 所有者或被授权人（需要写权限）；完全无权返回 404，权限不够返回 403
  const file = await fileService.findAccessibleById(userId, fileId, PERM_WRITE)

  try {
    // 写入仍按属主 id 限定，保持 SQL 层的纵深防御
    await fileService.updateName(file.userId, fileId, newName)
    return { success: true }
  } catch (err: any) {
    if (isUniqueError(err)) {
      throw createError({ statusCode: 409, message: '当前文件夹内已存在同名文件' })
    }
    throw createError({ statusCode: 500, message: err?.message || '重命名失败' })
  }
})