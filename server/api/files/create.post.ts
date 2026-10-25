// server/api/files/create.post.ts
//
// 新建空白文件。只收「叫什么名字、放在哪个目录」—— 对象路径、大小、直链全部
// 由服务端定。客户端只要能指定 fileKey，就等于能往别人的命名空间里写对象
// （这条教训见 server/utils/file-key.ts 的说明）。
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FolderService } from '~~/server/utils/db'
import { normalizeFolderId } from '~~/server/utils/folders'
import { createEmptyFile } from '~~/server/utils/create-empty-file'
import { cosObjectUrl, deleteCosObject, putEmptyObject } from '~~/server/utils/cos'
import { PERM_WRITE } from '~~/types/share'
import { userExpiredError, userNotFindError, dbConnectionError } from '~~/types/error'
import { quotaFailMessage } from '~~/server/utils/quota'
import { chainExpired, resolveQuotaChain } from '~~/server/utils/sub-account'

export default defineEventHandler(async (event) => {
  try {
    const { authUserId } = await getMeAndTarget(event)
    const authId = Number(authUserId)

    const body = (await readBody(event)) ?? {}
    const folderId = normalizeFolderId(body.folderId)
    const filename = body.filename

    const db = getDb(event)
    if (!db) throw dbConnectionError

    /**
     * 目标目录必须对我有 write，与上传 / 保存同一个判据。
     *
     * 文件归属**父目录的属主**：跨用户写（管理员代建、共享目录里新建）时
     * authId 与 ownerId 不同，而 key、这一行的 user_id、配额都要按属主算。
     * 传错就是把对象放进别人的命名空间 —— 属主校验反而会认为它合法。
     */
    let ownerId = authId
    if (folderId !== null) {
      const dest = await new FolderService(db).findAccessibleById(authId, folderId, PERM_WRITE)
      ownerId = dest.userId
    }

    const userRow: any = await db.prepare('SELECT id FROM users WHERE id = ?').bind(ownerId).first()
    if (!userRow) throw userNotFindError

    /**
     * 过期检查按**整条链**（与 save.post.ts 一致）：属主是子账户时，主账号
     * 套餐过期也会挡住他写入。
     *
     * 这里**不预占容量**：空白文件是 0 字节，不可能把谁顶出配额。拿
     * reserveStorage 过一道反而会造出一个奇怪的限制 —— 管理员把某人的额度
     * 调小之后，他连建一个空文件都不行了。真正需要挡的「还能不能写」就是
     * 上面这个过期判定。
     */
    const quotaChain = await resolveQuotaChain(db, ownerId)
    const expiredOn = await chainExpired(db, quotaChain)
    if (expiredOn.self) throw userExpiredError
    if (expiredOn.parent) {
      throw createError({
        statusCode: 403,
        message: await quotaFailMessage(db, 'expired_parent', ownerId, null, false)
      })
    }

    // 名字校验、重名消解、放对象、写库（以及失败时的清理）全在这一层里。
    const file = await createEmptyFile(db, ownerId, folderId, filename, {
      putEmptyObject,
      deleteObject: deleteCosObject,
      objectUrl: cosObjectUrl
    })

    return { success: true, statusMessage: '文件新建成功', file }
  } catch (error: any) {
    console.error('Create blank file error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '新建文件失败' })
  }
})
