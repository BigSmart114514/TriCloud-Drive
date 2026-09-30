// server/folders/ensure-paths.post.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { ensurePaths } from '~~/server/utils/folders'
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

    // 同 folders/create：父目录要 write，路径落在父目录属主的树下
    let ownerId = authId
    if (parentId !== null && parentId !== undefined) {
      const parent = await new FolderService(db).findAccessibleById(authId, Number(parentId), PERM_WRITE)
      ownerId = parent.userId
    }

    const map = await ensurePaths(db, ownerId, {
      parentId: parentId ?? null,
      paths: body?.paths,
    })

    return { success: true, map }
  } catch (error: any) {
    console.error('Ensure paths error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '确保目录失败' })
  }
})