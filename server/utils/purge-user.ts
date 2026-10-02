// 删用户时连带清掉 COS 上的对象。
//
// 抽出来是因为「删用户」现在有两条路：管理员删（manage/deleteUser）和
// 主账号删自己的子账户（accounts/delete）。COS 那 60 行抄一遍的话，
// 以后修分批大小或加凭证判断就得记得改两个文件 —— 而漏改的那个不会报错，
// 只会静默留下孤儿对象，用户花钱存的东西既查不到也删不掉。
import { FileService } from '~~/server/utils/db'

export interface PurgeResult {
  attempted: boolean
  /** false = 只清了一部分，或者压根没尝试。前端要据此提醒用户可能残留 */
  complete: boolean
  keys: number
}

/** 配置里的腾讯云密钥是不是真的配了（占位符不算）。 */
export function hasCosCredentials(config: any): boolean {
  return !!config?.tencentSecretId &&
    !!config?.tencentSecretKey &&
    config.tencentSecretId !== 'your_secret_id_here' &&
    config.tencentSecretKey !== 'your_secret_key_here' &&
    !!config?.cosBucket &&
    !!config?.cosRegion
}

/**
 * 删掉该用户名下所有文件对应的 COS 对象。
 *
 * **失败不抛** —— 调用方紧接着还要删数据库行，抛出去就变成「用户删不掉、
 * 文件还在」，那是最糟的结果（用户既拿不回来也删不掉）。返回
 * complete=false 让前端把「可能有残留」说出来就够了。
 *
 * SQLite 的 files 表没有行存 COS，孤儿对象是查不出来的，只能靠这里删干净。
 */
export async function purgeUserFiles(db: any, userId: number, config: any): Promise<PurgeResult> {
  const owned = await new FileService(db).listOwnedByUser(userId)
  const keys: string[] = Array.from(new Set(owned.map((f: any) => String(f.fileKey)).filter(Boolean)))

  if (!keys.length) return { attempted: false, complete: true, keys: 0 }
  if (!hasCosCredentials(config)) return { attempted: false, complete: true, keys: keys.length }

  let deleted = 0
  try {
    const COS = (await import('cos-nodejs-sdk-v5')).default
    const cos = new COS({ SecretId: config.tencentSecretId, SecretKey: config.tencentSecretKey })

    const chunkSize = 1000
    for (let i = 0; i < keys.length; i += chunkSize) {
      const batch = keys.slice(i, i + chunkSize).map((k) => ({ Key: k }))
      await new Promise((resolve, reject) => {
        cos.deleteMultipleObject(
          { Bucket: config.cosBucket, Region: config.cosRegion, Objects: batch, Quiet: true },
          (err: any, _data: any) => (err ? reject(err) : resolve(null))
        )
      })
      deleted += batch.length
    }

    const complete = deleted === keys.length
    if (complete) console.log(`COS: deleted ${deleted}/${keys.length} object(s) for user ${userId}`)
    else console.warn(`COS: partial deletion ${deleted}/${keys.length} for user ${userId}`)
    return { attempted: true, complete, keys: keys.length }
  } catch (e: any) {
    console.error(`COS delete error (user ${userId}):`, e)
    return { attempted: true, complete: false, keys: keys.length }
  }
}

/** 打开外键（SQLite 本地；D1 上这句会失败，忽略）。级联删 files/folders 依赖它。 */
export async function enableForeignKeys(db: any): Promise<void> {
  try {
    await db.prepare('PRAGMA foreign_keys = ON;').run()
  } catch { /* D1 不支持，忽略 */ }
}