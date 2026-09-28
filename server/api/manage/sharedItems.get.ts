// server/api/manage/sharedItems.get.ts
import { getQuery } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireAdmin } from '~~/server/utils/auth-middleware'
import { FileService } from '~~/server/utils/db'
import { dbConnectionError } from '~~/types/error'

/**
 * 列出某个用户**显式分享出去的**文件夹与文件（不限深度）。
 *
 * 判定条件与 FolderService.listSharedByOwner 一致：行自身 Shared = 1 或
 * IsPublic = 1。纯继承态（Shared = 2）不命中。
 *
 * 权限：仅管理员。数据本身是「已经公开或已经授权」的内容，但清单会暴露
 * 每个人的目录结构与被分享文件的分布，所以跟 /api/manage/* 其余接口同级别。
 */
export default defineEventHandler(async (event) => {
  const db = getDb(event)
  if (!db) throw dbConnectionError

  await requireAdmin(event)

  const q = getQuery(event) as { userId?: string }
  const userId = Number(q.userId)
  if (!Number.isInteger(userId) || userId < 1) {
    throw createError({ statusCode: 400, statusMessage: '非法的 userId' })
  }

  const { folders, files } = await new FileService(db).listSharedByOwner(userId)

  return {
    success: true,
    userId,
    folders,
    files
  }
})
