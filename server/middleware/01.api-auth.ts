// server/middleware/01.api-auth.ts
import { getMethod, getQuery, getRequestURL } from 'h3'
import { requireAuth, requireAdmin } from '~~/server/utils/auth-middleware'
import { normalizeShareLink } from '~~/types/share'

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

/**
 * 分享链接能匿名访问的四个（读 + 下载 + 整包下载清单 + 验有效性）。
 *
 * **只在带了合法形状的 link 时才匿名放行**，不带就照常 requireAuth ——
 * 开成「这三个接口永久免鉴权」等于开三个匿名入口。
 * 链接本身的有效性由各 handler 里的 linkGrants* 判定，中间件只管认不认这个参数。
 *
 * link 走 **query**（不放 body）：中间件要能只靠 getQuery 判完，
 * 不碰 readBody —— 那玩意在 handler 里还要再读一遍，缓存行为不该依赖中间件先读过。
 *
 * 这份名单与 PUBLIC_PATHS 是两回事：前者「本来就要给未登录用户调」，
 * 后者「凭一个能力凭据（token）调用，凭据对不对由 handler 判」。
 */
/**
 * resolve 是「验有效性」那一步：访客点开链接时不保证有账号，
 * 前端要判断该不该把这条链接从本地存储删掉，这一步必须匿名能做完。
 * 它返回 200/active:false 与 404 两种可区分的结果，别的都不删。
 */
const LINK_PUBLIC_PATHS = new Set([
  '/api/files',
  '/api/files/download',
  '/api/folders/manifest',
  '/api/share/link/resolve'
])

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

  if (LINK_PUBLIC_PATHS.has(path) && normalizeShareLink((getQuery(event) as any)?.link)) {
    return
  }

  await requireAuth(event)
})
