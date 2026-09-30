// server/middleware/01.api-auth.ts
import { getMethod, getRequestURL } from 'h3'
import { requireAuth, requireAdmin } from '~~/server/utils/auth-middleware'

/**
 * API 默认拒绝：所有 /api/** 先过这道中间件，再进具体 handler。
 *
 * 目的不是替 handler 兜底，而是把「每个接口都得记得自己写鉴权」这条隐式约定
 * 变成默认闭 —— 新加的接口忘了写 requireAuth/requireAdmin，当场 401，
 * 而不是静默裸奔。handler 里的调用保留，属于纵深防御。
 *
 * requireAuth 把结果缓存在 event.context 上，所以不会因为多这一层而多查一次库。
 */

/**
 * 必须匿名可调的三个。
 * - login / register：本来就要给未登录用户调
 * - logout：清 cookie 不该要求 token 仍然有效，否则 token 过期后用户再也退不出去
 *
 * 这份白名单就是「什么算未登录可访问」的唯一开关。加任何文件/目录/列表接口进来，
 * 等于开一个匿名入口 —— IsPublic 不提供这个能力，它只是「对所有已登录用户 READ」。
 */
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/logout'])

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // 只管 API。页面、静态资源、dev 的 HMR 端点一概不碰
  if (!path.startsWith('/api/')) return

  // CORS 预检不带 cookie，拦掉会让浏览器直接失败
  if (getMethod(event) === 'OPTIONS') return

  if (PUBLIC_PATHS.has(path)) return

  // 管理类一律要求管理员，角色判定在 requireAdmin 里（会查一次库）
  if (path.startsWith('/api/manage/')) {
    await requireAdmin(event)
    return
  }

  await requireAuth(event)
})
