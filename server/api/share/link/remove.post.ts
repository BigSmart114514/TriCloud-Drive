// server/api/share/link/remove.post.ts
//
// 按 token 撤销一个分享链接。
//
// 只收一个 link，**必须反查目标的属主再删** —— 不校验的话任何登录用户都能
// 删掉别人的链接（纯破坏，而且没有任何痕迹）。口径与 /api/share/mode 一致：
// 属主只能是自己；管理员代管时 authUserId 已经是 targetUserId，同一套判定自动放行。
//
// 撤销不存在/已撤销的链接返回成功（幂等），见 deleteShareLink 的注释。
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { deleteShareLink, requireShareLink } from '~~/server/utils/share-link'

export default defineEventHandler(async (event) => {
  try {
    const { authUserId } = await getMeAndTarget(event)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const body = await readBody(event)
    const link = requireShareLink(body?.link)

    await deleteShareLink(db, link, Number(authUserId))

    return { success: true, statusMessage: '分享链接已撤销', link }
  } catch (error: any) {
    console.error('Share link remove error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '撤销分享链接失败' })
  }
})
