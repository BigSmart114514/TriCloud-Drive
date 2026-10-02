// 腾讯云 COS 的删除。
//
// ## 为什么要单独一个模块
//
// 「配没配密钥」这道守卫 + 「建客户端」+ 「deleteObject 包 Promise」这三步，
// 在本项目里被**逐字抄了四遍**：files/delete.post.ts、folders/delete.post.ts、
// copy/paste.post.ts、utils/purge-user.ts。第五个使用方是 files/save.post.ts
// —— 它要清掉「已经传上去、但数据库事务回滚了」的孤儿对象。
//
// 五份里任何一份改了守卫条件（比如加上 CDN 域名判断），其余四份就会静默失配：
// 该删的对象没删，桶里的空间只增不减，而没有任何报错。
//
// ## 语义：尽力而为，不抛
//
// 删除**永远不抛**。调用方的目的是「清理」，不是为了判成败 ——
// 一个已经失败的请求再去抛第二个错误，只会把第一个真正的失败原因盖掉。
// 删不掉就记一条日志，返回 false，由调用方决定要不要记着。
//
// 幂等：删一个不存在的 key，COS 返回 204，仍然算成功。
// useRuntimeConfig 靠 Nuxt 自动导入（与 db-adapter.ts、auth-middleware.ts 一致）。
// 这里刻意不写 `import { useRuntimeConfig } from '#imports'`：项目里没有第二处那么写，
// 而测试的 resolve hook 也不认那个 specifier。

/** 密钥是否真的配了。占位符（your_secret_id_here）不算 —— 那是模板里的样例值。 */
export function cosConfigured(): boolean {
  const config = useRuntimeConfig()
  const id = config.tencentSecretId as string | undefined
  const key = config.tencentSecretKey as string | undefined
  return !!(
    id &&
    key &&
    id !== 'your_secret_id_here' &&
    key !== 'your_secret_key_here'
  )
}

async function getCos() {
  const config = useRuntimeConfig()
  const COS = (await import('cos-nodejs-sdk-v5')).default
  return {
    cos: new COS({
      SecretId: config.tencentSecretId as string,
      SecretKey: config.tencentSecretKey as string
    }),
    bucket: config.cosBucket as string,
    region: config.cosRegion as string
  }
}

/**
 * 删一个对象。**永不抛**。
 *
 * @returns true = 删掉了或本来就不存在；false = 没配密钥或调用失败
 */
export async function deleteCosObject(key: string): Promise<boolean> {
  if (!key) return true
  if (!cosConfigured()) {
    // 没配密钥 = 本地 demoMode，本来就没有真对象可删
    return false
  }
  try {
    const { cos, bucket, region } = await getCos()
    await new Promise<void>((resolve, reject) => {
      cos.deleteObject({ Bucket: bucket, Region: region, Key: key }, (err: any) => {
        if (err) reject(err)
        else resolve()
      })
    })
    return true
  } catch (err: any) {
    console.error('[cos] 删除对象失败:', key, err?.message || err)
    return false
  }
}

/**
 * 批量删。**永不抛**。逐个调用 deleteObject，避免批量接口部分失败时的语义歧义。
 */
export async function deleteCosObjects(keys: string[]): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = []
  const failed: string[] = []
  for (const k of keys) {
    if (await deleteCosObject(k)) ok.push(k)
    else failed.push(k)
  }
  return { ok, failed }
}
