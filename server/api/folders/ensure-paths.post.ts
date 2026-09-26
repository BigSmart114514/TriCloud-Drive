// server/folders/ensure-paths.post.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { ensurePaths } from '~~/server/utils/folders'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  try {
    const { targetUserId } = await getMeAndTarget(event)
    const userId = Number(targetUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const body = await readBody(event)
    const map = await ensurePaths(db, userId, {
      parentId: body?.parentId,
      paths: body?.paths,
    })

    return { success: true, map }
  } catch (error: any) {
    console.error('Ensure paths error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '确保目录失败' })
  }
})