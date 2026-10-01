// server/api/share/link/add.post.ts
//
// 生成一个分享链接。参数 { type: 'file'|'folder', id }。
//
// **没有单独的管理员端点**：useAdmin 走原来的 getMeAndTarget 就行 ——
// 它已经把 authUserId 换成 targetUserId，于是下面 resolveShareTarget 的
// 「必须是属主」判定自动变成「必须是这个被浏览用户的」，和 /api/share/mode
// 一模一样。非管理员传 useAdmin 照旧 403，超管进超管数据域那道防线也照旧生效。
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { assertShareTargetType, assertTargetId, resolveShareTarget } from '~~/server/utils/share'
import { buildShareLinkUrl, createShareLink, listShareLinks, withShareLinkUrls } from '~~/server/utils/share-link'

export default defineEventHandler(async (event) => {
  try {
    const { authUserId } = await getMeAndTarget(event)
    const ownerId = Number(authUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const body = await readBody(event)
    const type = assertShareTargetType(body?.type)
    const targetId = assertTargetId(body?.id)

    // 属主专属：授权管理是属主的权力，与访问权限无关
    const target = await resolveShareTarget(db, type, targetId, ownerId)

    const created = await createShareLink(db, target)

    return {
      success: true,
      statusMessage: '分享链接已生成',
      link: created.link,
      url: buildShareLinkUrl(event, created.link),
      // 一起返回完整列表，省得前端再拉一次；结构与 /api/share/list 的 links 一致
      links: withShareLinkUrls(event, await listShareLinks(db, target))
    }
  } catch (error: any) {
    console.error('Share link add error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '生成分享链接失败' })
  }
})
