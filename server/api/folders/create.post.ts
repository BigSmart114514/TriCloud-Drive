// server/api/folders/create.post.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { createFolder } from '~~/server/utils/folders'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  try {
    const { targetUserId } = await getMeAndTarget(event)
    const userId = Number(targetUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const body = await readBody(event)
    const folder = await createFolder(db, userId, {
      name: body?.name,
      parentId: body?.parentId,
    })

    return { success: true, folder }
  } catch (error: any) {
    console.error('Create folder error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '创建文件夹失败' })
  }
})