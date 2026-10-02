// server/api/manage/updateUser.post.ts
import { getMethod, readBody } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireAdmin } from '~~/server/utils/auth-middleware'

function toBool(v: any) {
  return v === true || v === 1 || v === '1'
}

export default defineEventHandler(async (event) => {
  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  // 管理员门控：这个接口能改 IsSuperAdmin / 配额 / 有效期，
  // 漏了校验等于任何登录用户都能给自己提权，必须在读 body 之前就拦住
  const me = await requireAdmin(event)

  try {
    const body = await readBody(event)
    const {
      id,
      IsAdmin,
      IsSuperAdmin,
      maxStorage,
      usedStorage,
      maxDownload,
      usedDownload,
      expire_at,
      canSubAccount,
      maxSubAccount
    } = body || {}

    if (!id && id !== 0) {
      throw createError({ statusCode: 400, message: '缺少用户ID' })
    }

    const db = getDb(event)
    if (!db) throw createError({ statusCode: 500, message: '数据库连接失败' })

    // 角色校验。原来这里只有 requireAdmin，然后直接 UPDATE，**不看目标是谁、
    // 也不看请求想把谁变成什么角色**，于是有两个提权口：
    //   1. 给自己勾 IsSuperAdmin → 变超管 → deleteUser 就再也拦不住他
    //   2. 取消真超管的 IsSuperAdmin → 把他降级 → 再删掉
    // deleteUser.post.ts 一直有下面这条规则，这里是同一个模型的另一半，缺了它
    // 就变成「能改不能删」，而改才是提权入口。
    const target = await db
      .prepare('SELECT id, username, IsAdmin, IsSuperAdmin FROM users WHERE id = ?')
      .bind(id)
      .first()
    if (!target) {
      throw createError({ statusCode: 404, message: '用户不存在' })
    }
    const targetIsAdmin = toBool(target.IsAdmin)
    const targetIsSuperAdmin = toBool(target.IsSuperAdmin)

    if (!me.isSuperAdmin) {
      // 规则一：普通管理员只能改普通用户（与 deleteUser 一致）
      if (targetIsAdmin || targetIsSuperAdmin) {
        throw createError({ statusCode: 403, message: '普通管理员不能修改管理员或超级管理员' })
      }
      // 规则二：普通管理员不能授予超管。否则他能造出一个自己按 deleteUser
      // 规则无权删除的超管，等于绕过整个模型把自己人抬上去。
      // 授 IsAdmin 仍然允许（目标本来是普通用户，改完是管理员，
      // 与 deleteUser 的不对称是刻意的：要收紧就一起改 deleteUser）
      if (toBool(IsSuperAdmin)) {
        throw createError({ statusCode: 403, message: '普通管理员不能授予超级管理员' })
      }
    }

    // 基本数值清洗，确保为非负数
    const toNonNegativeNumber = (v: any) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }

    /**
     * 这里**故意不写 parent_id**。
     *
     * 能改 parent_id 就等于两件不该有的能力：把任意普通用户改写成别人的子账户
     * （然后就能花那个人的池），或者单方面解除父子关系（凭空释放一个池额度）。
     * 父子关系只有两个入口能改：建号（accounts/index.post）和删除
     * （accounts/delete），两个都带 parent_id = 我 的判定。
     *
     * 另外 canSubAccount / maxSubAccount 用 COALESCE 兜底：老前端不传这两个
     * 字段时不该把它们清零，否则改一次额度顺手把他的建号能力关了。
     */
    const sql = `
      UPDATE users
      SET
        IsAdmin = ?,
        IsSuperAdmin = ?,
        maxStorage = ?,
        usedStorage = ?,
        maxDownload = ?,
        usedDownload = ?,
        expire_at = ?,
        canSubAccount = COALESCE(?, canSubAccount),
        maxSubAccount = COALESCE(?, maxSubAccount)
      WHERE id = ?
    `
    const stmt = db.prepare(sql)
    await stmt
      .bind(
        IsAdmin ? 1 : 0,
        IsSuperAdmin ? 1 : 0,
        toNonNegativeNumber(maxStorage),
        toNonNegativeNumber(usedStorage),
        toNonNegativeNumber(maxDownload),
        toNonNegativeNumber(usedDownload),
        expire_at,
        canSubAccount === undefined || canSubAccount === null ? null : (toBool(canSubAccount) ? 1 : 0),
        maxSubAccount === undefined || maxSubAccount === null ? null : toNonNegativeNumber(maxSubAccount),
        id
      )
      .run()

    return { success: true }
  } catch (error: any) {
    // createError 原样抛出。原来这里一律改写成 500，上面的 403 角色拒绝
    // 会变成「Internal Server Error」，前端看不出是权限问题（listUsers 已修过同样的坑）
    if (error?.statusCode) throw error
    console.error('updateUser error:', error)
    throw createError({ statusCode: 500, statusMessage: 'Internal Server Error' })
  }
})