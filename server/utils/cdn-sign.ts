// CDN 鉴权 URL 的签名（腾讯云 CDN TypeA）。
//
// ## 为什么要抽出来
//
// 原来 `generateCDNUrl` 是 files/download.post.ts 里的局部函数，只有一个调用点。
// 存储桶管理要多一个用法（给**孤儿对象**签下载链接 —— 孤儿对象没有 files 行，
// 而那条端点的第一步就是按 id 查行，所以它走不通那条路）。
//
// 抄一份是最坏的选择，而这项目对「抄了 N 份」有明确教训：cos.ts 的文件头
// 记着「配没配密钥 + 建客户端 + deleteObject 包 Promise」这三步被逐字抄了
// 五遍，其中一份改了守卫条件而其余四份静默失配 —— 该删的对象没删，桶里的
// 空间只增不减，而且没有任何报错。所以签名这里同样只留一份。
//
// ## backupKey 为什么传进来却不用
//
// 形参有 backupKey，函数体只用 primaryKey（`const secret = primaryKey`）。
// 这是既有行为，**原样保留**：签名算法与 CDN 后台配的主/备密钥哪一份生效
// 有关，改它要连着改 CDN 的配置，而那不在本仓库里、也不该由这里猜。
// 留着形参是为了让调用点不必解释「为什么只传了一个」。
//
// 抽出来的唯一目的就是复用，不是改行为 —— 所以函数体逐字未动。
import crypto from 'crypto'

/**
 * 生成 CDN 鉴权 URL（TypeA）。
 *
 * @param fileKey     COS 里的真实对象路径。**必须是刚鉴权通过的那一行**，
 *                    不是请求里的 —— 见 download.post.ts 里那段长注释。
 * @param filename    传了就带 response-content-disposition，让浏览器按这个名字存盘
 */
export const generateCDNUrl = (
  fileKey: string,
  cdnDomain: string,
  primaryKey: string,
  backupKey: string,
  ttl: number,
  authParam: string,
  filename?: string
) => {
  void backupKey // 见文件头：形参保留，函数体只用 primaryKey

  const timestamp = Math.floor(Date.now() / 1000) + ttl
  const path = `/${fileKey}`
  const rand = Math.floor(Math.random() * 1000000).toString()
  const uid = 0

  const secret = primaryKey
  const authString = `${path}-${timestamp}-${rand}-${uid}-${secret}`
  const sign = crypto.createHash('md5').update(authString).digest('hex')

  const authValue = `${timestamp}-${rand}-${uid}-${sign}`

  const params = new URLSearchParams()
  params.set(authParam, authValue)
  if (filename) {
    params.set('response-content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
  }

  return `https://${cdnDomain}${path}?${params.toString()}`
}

/**
 * 没有配 CDN 域名时的直链。
 *
 * 同样抽出来，因为「有没有 CDN」这个分支在两个地方都要判，而它判错的后果是
 * 悄悄发出一个没有签名、或者指向错误域名的 URL —— 两种都不会报错。
 */
export function cosDirectUrl(bucket: string, region: string, fileKey: string): string {
  return `https://${bucket}.cos.${region}.myqcloud.com/${fileKey}`
}