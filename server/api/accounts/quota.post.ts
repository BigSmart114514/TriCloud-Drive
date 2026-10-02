// server/api/accounts/quota.post.ts
// 主账号改某个子账户的额度 / 到期时间 / 能否改密码。
//
// **刻意不碰 IsAdmin / IsSuperAdmin / parent_id**：
//   - 角色：子账户不该是管理员。给了就能进 /manage，是提权。
//   - parent_id：能改就等于能把自己变成别人的孩子（白拿别人的池），
//     或者单方面解除父子关系（等于凭空释放一个池额度）。
// 所以这条接口只认下面这几个字段，其余一律不动。
import { getDb } from '~~/server/utils/db-adapter'
import { requireAuth } from '~~/server/utils/auth-middleware'
import { checkNonNegative, requireOwnChild } from '~~/server/utils/account'
import { isSqlDateTimeString } from '~~/server/utils/time'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const meId = Number(me.userId)
  const db = getDb(event)
  if (!db) throw dbConnectionError

  const body = await readBody(event).catch(() => null)
  const id = Number(body?.id)
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, message: '缺少子账户 ID' })

  // 归属判定：不是我的孩子就 404（不是 403）—— 403 会泄露「这个 id 存在」
  const child = await requireOwnChild(db, meId, id)
  if (!child) throw createError({ statusCode: 404, message: '子账户不存在' })

  const sets: string[] = []
  const params: any[] = []

  for (const [key, label] of [['maxStorage', '存储上限'], ['maxDownload', '下载上限']] as const) {
    if (body?.[key] !== undefined) {
      const v = Number(body[key])
      const bad = checkNonNegative(v)
      if (bad) throw createError({ statusCode: 400, message: `${label}${bad}` })
      sets.push(`${key} = ?`)
      params.push(v)
    }
  }

  if (body?.expire_at !== undefined) {
    const v = body.expire_at == null || body.expire_at === '' ? null : String(body.expire_at)
    if (v != null && !isSqlDateTimeString(v)) {
      throw createError({ statusCode: 400, message: '到期时间格式不正确' })
    }
    sets.push('expire_at = ?')
    params.push(v)
  }

  if (body?.canChangePassword !== undefined) {
    sets.push('canChangePassword = ?')
    params.push(body.canChangePassword ? 1 : 0)
  }

  if (!sets.length) throw createError({ statusCode: 400, message: '没有要修改的内容' })

  params.push(id, meId)
  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND parent_id = ?`)
    .bind(...params)
    .run()

  return { success: true, statusMessage: '已保存' }
})