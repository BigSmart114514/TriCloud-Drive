// /api/manage/bucket/download — 给桶里的任意对象签一个下载链接。
//
// ## 为什么要单独一条，而不是复用 /api/files/download
//
// 那条端点的第一步是「按 id 查 files 行」，而**孤儿对象没有行** —— 正是它要
// 下载的东西恰好是那条路唯一处理不了的东西。所以走不通。
//
// ## 为什么「无条件」
//
// 用户明确要的是无条件：给什么 key 就签什么 key，不要求它有 files 行、不要求
// 它在孤儿列表里、不要求它够旧、不要求它在某个命名空间下。
//
// 与 purge 的守卫强度**故意不对称**，理由是两者不可逆性不同：
//
//   签名下载  读操作。签出去的东西不会消失，链接过期（cdnAuthTtl，默认 10 秒）
//             就失效。用完再签一次就行。
//   删除      不可逆。字节没了就是没了，审计表只能事后回答、不能还原。
//
// 所以读放宽到「超管就能签」，写仍然卡死命名空间（purge-orphans 的
// partitionPurgeableKeys）。把读也卡到那个程度只会让人多绕一次，
// 而绕的那次还不在审计里。
//
// SSRF 不成立：generateCDNUrl 拼的是 `https://${cdnDomain}/${fileKey}`，
// 而 cdnDomain 来自配置。所以 fileKey 传 `//evil.com/x` 得到的仍是
// `https://<CDN>///evil.com/x` —— 请求照样打到自家 CDN。
//
// ## 配额不记在这个用户头上
//
// 孤儿对象不在 `SUM(file_size)` 里（没有行），所以它既不占存储配额，
// 管理员把它下载走也不该扣用户的 `usedDownload` —— 那不是用户在下载，
// 是管理员在执行一次数据恢复。真要扣的话，一次恢复动作就能把用户的
// 下载额度耗光，而那个下载对他没有任何意义。
import { defineEventHandler, getQuery, createError } from 'h3'
import { requireSuperAdmin } from '~~/server/utils/auth-middleware'
import { generateCDNUrl, cosDirectUrl } from '~~/server/utils/cdn-sign'
import { displayNameFromKey } from '~~/server/utils/file-key'

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const q = getQuery(event)
  const key = q?.key

  // 只挡「不是个 key」的两类。不挡命名空间 —— 见文件头。
  if (typeof key !== 'string' || !key.trim()) {
    throw createError({ statusCode: 400, message: '缺少 key' })
  }
  if (key.length > 1024) {
    throw createError({ statusCode: 400, message: 'key 过长' })
  }
  if (key.includes('\n') || key.includes('\r')) {
    // 会把 Content-Disposition 的头打散。不是安全问题，是不能签出一个坏请求。
    throw createError({ statusCode: 400, message: 'key 含非法字符' })
  }

  const config = useRuntimeConfig()

  if (!config.cosBucket) {
    throw createError({ statusCode: 400, message: '未配置存储桶' })
  }

  /**
   * 文件名是从 key 反推的，而两种 key 格式携带的信息量不同：
   *
   *   u/<id>/<日期>/<ts>_<rand>_<名字>   名字还在 key 里，能还原
   *   users/<id>/<YYYYMM>/<uuid><ext>   只有 uuid，原名只在那一行 files 里，
   *                                     而那一行已经没了
   *
   * 所以 recoverable 如实标出来 —— 界面据此告诉操作者「这个文件名恢复不了」，
   * 而不是让他花时间点开一个 32 位十六进制串去找。
   */
  const name = displayNameFromKey(key)

  const useCDN = !!config.cdnDomain
  const url = useCDN
    ? generateCDNUrl(
        key,
        config.cdnDomain as string,
        config.cdnAuthKeyPrimary as string,
        config.cdnAuthKeyBackup as string,
        config.cdnAuthTtl as number,
        config.cdnAuthParam as string,
        name.name
      )
    : cosDirectUrl(config.cosBucket as string, config.cosRegion as string, key)

  return {
    url,
    filename: name.name,
    filenameRecoverable: name.recoverable,
    useCDN,
    // 与 files/download 的 expiresAt 同一口径：签名时刻 + cdnAuthTtl
    expiresAt: new Date(Date.now() + ((config.cdnAuthTtl as number) || 0) * 1000).toISOString()
  }
})