// server/api/manage/deleteUser.post.ts
import { defineEventHandler, readBody, createError, getMethod } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { requireAuth } from '~~/server/utils/auth-middleware'

function toBool(v: any) {
  return v === true || v === 1 || v === '1'
}

export default defineEventHandler(async (event) => {
  const auth = await requireAuth(event)

  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }

  const body = await readBody<{ id: number | string }>(event)
  const userId = Number(body?.id)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, statusMessage: '参数错误：id' })
  }

  const db = getDb(event)

  // 获取当前登录用户并校验权限
  const current: any = await db
    .prepare('SELECT id, IsAdmin, IsSuperAdmin FROM users WHERE id = ?')
    .bind(auth.userId)
    .first()

  if (!current) {
    throw createError({ statusCode: 401, statusMessage: '未登录或用户不存在' })
  }

  const isAdmin = toBool(current.IsAdmin)
  const isSuperAdmin = toBool(current.IsSuperAdmin)

  if (!isAdmin && !isSuperAdmin) {
    throw createError({ statusCode: 403, statusMessage: '无权限' })
  }

  // 查询目标用户
  const target: any = await db
    .prepare('SELECT id, email, username, IsAdmin, IsSuperAdmin FROM users WHERE id = ?')
    .bind(userId)
    .first()

  if (!target) {
    throw createError({ statusCode: 404, statusMessage: '用户不存在' })
  }

  const targetIsAdmin = toBool(target.IsAdmin)
  const targetIsSuperAdmin = toBool(target.IsSuperAdmin)

  // 权限规则：
  // - 超管可以删除任何用户，但不能删除系统最后一个超管
  // - 管理员只能删除普通用户（不能删管理员或超管）
  if (!isSuperAdmin) {
    if (targetIsAdmin || targetIsSuperAdmin) {
      throw createError({ statusCode: 403, statusMessage: '普通管理员不能删除管理员或超级管理员' })
    }
  }

  // 若要删除的是超管，确保不是最后一个超管
  if (targetIsSuperAdmin) {
    const row: any = await db
      .prepare('SELECT COUNT(1) AS cnt FROM users WHERE IsSuperAdmin = 1')
      .first()
    const cnt = Number(row?.cnt ?? 0)
    if (cnt <= 1) {
      throw createError({ statusCode: 400, statusMessage: '不能删除最后一个超级管理员' })
    }
  }

  // 读取待删除用户的全部文件 key（用于 COS 删除）
  const ownedFiles = await new FileService(db).listOwnedByUser(userId)
  const keys: string[] = Array.from(
    new Set(ownedFiles.map((f) => String(f.fileKey)).filter(Boolean))
  )

  // 处理 COS 删除
  const config = useRuntimeConfig()
  let cosAttempted = false
  let cosDeleteAll = false

  const hasCosCreds =
    !!config.tencentSecretId &&
    !!config.tencentSecretKey &&
    config.tencentSecretId !== 'your_secret_id_here' &&
    config.tencentSecretKey !== 'your_secret_key_here' &&
    !!config.cosBucket &&
    !!config.cosRegion

  if (keys.length > 0 && hasCosCreds) {
    cosAttempted = true
    try {
      const COS = (await import('cos-nodejs-sdk-v5')).default
      const cos = new COS({
        SecretId: config.tencentSecretId,
        SecretKey: config.tencentSecretKey,
      })

      const chunkSize = 1000
      let deletedCount = 0

      for (let i = 0; i < keys.length; i += chunkSize) {
        const batch = keys.slice(i, i + chunkSize).map((k) => ({ Key: k }))
        await new Promise((resolve, reject) => {
          cos.deleteMultipleObject(
            {
              Bucket: config.cosBucket,
              Region: config.cosRegion,
              Objects: batch,
              Quiet: true,
            },
            (err: any, data: any) => {
              if (err) {
                console.error('COS batch delete error (deleteUser):', err)
                reject(err)
              } else {
                deletedCount += batch.length
                resolve(data)
              }
            }
          )
        })
      }

      cosDeleteAll = deletedCount === keys.length
      if (cosDeleteAll) {
        console.log(`COS: deleted ${deletedCount}/${keys.length} object(s) for user ${userId}`)
      } else {
        console.warn(`COS: partial deletion ${deletedCount}/${keys.length} for user ${userId}`)
      }
    } catch (e: any) {
      console.error('COS delete error (deleteUser):', e)
      cosDeleteAll = false
    }
  }

  // 确保开启外键（SQLite 本地），D1 失败就忽略
  try {
    await db.prepare('PRAGMA foreign_keys = ON;').run()
  } catch {}

  // 删除用户（files、folders 表通过 ON DELETE CASCADE 自动级联删除）
  try {
    await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
  } catch (e: any) {
    throw createError({ statusCode: 500, statusMessage: e?.message || '删除失败' })
  }

  return {
    success: true,
    message:
      cosAttempted && !cosDeleteAll
        ? '用户已删除，但 COS 文件删除可能失败'
        : '用户及其 COS 文件已删除',
    cosAttempted,
    cosDeleteAll,
  }
})