// server/api/folders/create.post.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { createFolder } from '~~/server/utils/folders'
import { FolderService } from '~~/server/utils/db'
import { PERM_WRITE } from '~~/types/share'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  try {
    const { authUserId } = await getMeAndTarget(event)
    const authId = Number(authUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const body = await readBody(event)
    const parentId = body?.parentId ?? null

    // 父目录必须对我有 write。原来直接 createFolder(db, targetUserId, …)，
    // 普通用户传 targetUserId=<属主> 就能在别人树里建目录。
    // 新目录归属父目录属主（触发器也要求父子 user_id 一致）。
    let ownerId = authId
    if (parentId !== null && parentId !== undefined) {
      const parent = await new FolderService(db).findAccessibleById(authId, Number(parentId), PERM_WRITE)
      ownerId = parent.userId
    }

    const folder = await createFolder(db, ownerId, {
      name: body?.name,
      parentId: parentId ?? null,
    })

    return { success: true, folder }
  } catch (error: any) {
    console.error('Create folder error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '创建文件夹失败' })
  }
})