// 按名称搜索文件与目录。
//
// ## 两种 scope 是两种权限边界，不是同一个查询的宽窄
//
//   scope=mine  → 只搜**自己拥有的**树（user_id = 我）
//   scope=site  → 全站（所有用户的树），**仅超级管理员**可用
//
// 首页只给 mine。文件管理页给超管 site，普通管理员连入口都没有
// （前端不显示按钮，服务端在这里也拦）。
//
// ## 为什么不用 getMeAndTarget
//
// 那个函数是为「以谁的身份、对谁的数据、用不用管理权限」三件事一起解出来的，
// 它的 targetUserId / useAdmin 会被当成数据范围和提权开关。搜索这两样都不需要：
// 范围由 scope 一个词定死，全站与否只取决于调用者是不是超管。走 getMeAndTarget
// 反而要提防「传 targetUserId 圈定了别人的范围」这类组合 —— 少一个可调参数
// 就少一类越权。
//
// ## 为什么是硬性的 isSuperAdmin 而不是 isAdmin
//
// isAdmin 是 IsAdmin || IsSuperAdmin（见 app/composables/useAuth.ts），普通
// 管理员也是 true。需求是「超管才能全站搜，普通管理员不行」，所以只认
// IsSuperAdmin。判定用服务端查出来的值（requireAuth 的 withUser），不信任
// 前端传来的任何东西。
//
// ## 为什么不做 targetUserId 的「限定某人」
//
// 全站搜索的结果按属主分行显示、点击就切过去，本来就不需要先选人。
// 再加一个「只看某人」的参数，等于把一个权限边界拆成两个可组合的参数，
// 组合爆炸却没有任何用例。

import { requireAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { searchFiles, searchFolders, SEARCH_RESULT_LIMIT } from '~~/server/utils/search'
import { getQuery } from 'h3'

/** 关键词长度上限。LIKE 的模式串长度直接决定扫描成本，拦在这里比拦在 UI 可靠 */
const MAX_KEYWORD_LENGTH = 100

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event, { withUser: true })

  const q = getQuery(event)
  const scope = String(q?.scope ?? 'mine')
  const keyword = String(q?.q ?? '').trim()

  if (scope !== 'mine' && scope !== 'site') {
    throw createError({ statusCode: 400, message: 'scope 只能是 mine 或 site' })
  }

  // 普通管理员在这里被拦下。前端不给入口是第一道，这里才是边界本身 ——
  // 入口只管 UI，直接打接口不需要经过它。
  if (scope === 'site' && !me.isSuperAdmin) {
    throw createError({ statusCode: 403, message: '仅超级管理员可以搜索全站文件' })
  }

  if (!keyword) {
    return {
      success: true,
      scope,
      keyword: '',
      folders: [],
      files: [],
      truncated: false,
      // 空结果也带上：前端只有拿到它才知道截断文案里该写多少
      limit: SEARCH_RESULT_LIMIT
    }
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    throw createError({
      statusCode: 400,
      message: `关键词过长，最多 ${MAX_KEYWORD_LENGTH} 个字符`
    })
  }

  const db = getDb(event)
  if (!db) throw dbConnectionError

  // scope=mine 传死自己的 id：不是「默认值」，是这次搜索的权限边界。
  // 注意用的是 me.userId 而不是任何请求参数 —— 首页请求根本不会带 targetUserId，
  // 带了也不认。
  const ownerId = scope === 'mine' ? Number(me.userId) : null

  // 串行，不是 Promise.all：同一 sqlite3 handle 并发跑语句时本机原生绑定崩过
  // （server/api/files/index.get.ts:251 有同样的说明）。
  const folders = await searchFolders(db, keyword, ownerId)
  const files = await searchFiles(db, keyword, ownerId)

  return {
    success: true,
    scope,
    keyword,
    folders: folders.hits,
    files: files.hits,
    truncated: folders.truncated || files.truncated,
    // 截断文案要写「只显示前 N 条」，N 由这里给出 ——
    // 别让前端再抄一份常量，抄了就会漂。
    limit: SEARCH_RESULT_LIMIT
  }
})
