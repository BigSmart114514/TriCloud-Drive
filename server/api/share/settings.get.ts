// 分享管理列表：我设置过分享的全部文件与文件夹。
//
// 所有登录用户都有这个页面，数据只涉及自己，所以**没有管理员分支**。
// 管理员在 /manage/files 里能替别人看文件，但那是「看别人的文件」，
// 不是「管理别人的分享设置」——后者要改数据，是属主专属权力。
// 所以这里用 requireAuth 拿自己的 id，不读 query 里的任何用户参数：
// 少一个可调参数就少一类越权（口径与 /api/share/mode 一致，见该文件的说明）。
//
// 判据与三态/公开/人数/链接数的含义见 server/utils/share-settings.ts。

import { requireAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { listShareSettings, SHARE_SETTINGS_LIMIT } from '~~/server/utils/share-settings'

/** 请求里能传的上限。传更大的按这个封顶，不报错 —— 前端只是提前少拿几条 */
const MAX_LIMIT = 500

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const ownerId = Number(me.userId)

  const q = getQuery(event)
  const raw = Number(q?.limit)
  const limit =
    Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : SHARE_SETTINGS_LIMIT

  const db = getDb(event)
  if (!db) throw dbConnectionError

  const result = await listShareSettings(db, ownerId, limit)

  return {
    success: true,
    folders: result.folders,
    files: result.files,
    summary: result.summary,
    truncated: result.truncated,
    limit
  }
})
