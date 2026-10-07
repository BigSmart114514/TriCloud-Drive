// 腾讯云 COS 的**列举**。
//
// 删除在 cos.ts，本文件是它的另一半 —— 而列举比删除危险得多，所以单独一个模块。
//
// ## 为什么不把列举塞进 cos.ts
//
// 删除的四份抄写里没有任何一份需要「分页」：删一个 key 是一次幂等请求。
// 而列举天然要翻页、要判断「翻完了没有」、要在翻到一半失败时说清「只拿到一半」。
// 这些状态没法表达成一个 `Promise<boolean>`，硬塞进 cos.ts 会把那个模块的
// 语义（「尽力而为、永远不抛」）撑破 —— 列举**必须**说清成败。
//
// ## 绝对不要设 EncodingType
//
// SDK 支持 `EncodingType: 'url'`，一开返回的 Key 就是**百分号编码**的：
// `a b.txt` → `a%20b.txt`。而 databases 里 `files.file_key` 存的是原始 key，
// 于是差集永远匹配不上 ——
//
//     对象数 80000，数据库行数 200，孤儿数 80000
//
// 表现是「这个用户的每一个文件都是孤儿」。而本项目的孤儿列表带删除按钮。
// 所以这里根本不接受 encoding 参数，不是「默认关掉」而是「没有这个选项」：
// 少一个能打开的开关，少一个能踩进去的坑。
//
// ## incomplete 与 error 是两件事，别合成一个
//
//   incomplete  列举**没能覆盖全**（翻页中途失败 / 撞到硬上限 / COS 没配密钥）
//   error       具体原因，给人看的
//
// 调用方要按 incomplete 决定「这份结果能不能拿去删」，而不是按 error。
// 同一个 incomplete 有多种成因，而处置方式只有一种：不许删。
import { cosConfigured } from '~~/server/utils/cos'

/** 一个对象的只读信息。字段名对齐 SDK 的 CosObject，别自己另起一套。 */
export interface CosObjectInfo {
  key: string
  /** 字节。SDK 返回的是字符串，这里转成 number —— 后面要拿它求和 */
  size: number
  /** ISO8601，如 `2019-05-24T10:56:40Z` */
  lastModified: string
  etag: string
  /** STANDARD / STANDARD_IA / ARCHIVE… 老对象可能是低频，这个值能看出来 */
  storageClass: string
}

export interface CosListPage {
  objects: CosObjectInfo[]
  /** 有 Delimiter 时，那些「目录」的路径前缀。用来把月份分区列出来 */
  commonPrefixes: string[]
  /** 还有下一页吗。为 false 时 nextMarker 无意义 */
  truncated: boolean
  nextMarker: string | null
  /** 列举失败的原因。**不代表没数据** —— 可能是翻到一半断的 */
  error?: string
}

export interface CosListAll {
  objects: CosObjectInfo[]
  /** 没能覆盖全整个 prefix。见文件头。**为真时结果不可用于删除决策** */
  incomplete: boolean
  error?: string
  /** 翻了多少页。排查「为什么 incomplete」时有用 */
  pages: number
}

/** COS 单次 List 硬上限 1000，写死以免调用方传个更大的值然后静默被截 */
const COS_MAX_KEYS = 1000

/** 翻页硬上限。防死循环，也顺便给「这个 prefix 大到不现实」一个信号 */
const DEFAULT_MAX_PAGES = 200

/** 收对象数的硬上限。真到 20 万个对象时应该报错让人来缩小范围，而不是继续翻 */
const DEFAULT_MAX_OBJECTS = 50_000

async function getCosClient() {
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
 * 列一页。**会 throw** —— 与 cos.ts 的删除相反。
 *
 * 列举失败必须让调用方知道，否则「拿到空列表」和「这个 prefix 是空的」
 * 分不开，而前者会导致把整个 namespace 当成没有对象。
 *
 * 注意这里也没有「没配密钥就返回空」：没配密钥在本地 demoMode 下是常态，
 * 但那意味着**根本没有任何真对象**，返回空列表是如实的。要不要提示由页面决定。
 */
export async function listCosObjectsPage(params: {
  prefix: string
  marker?: string
  /** 1..1000 */
  maxKeys?: number
  /** '/' = 按目录分组，文件不再单独返回。浏览器的目录树靠它 */
  delimiter?: string
}): Promise<CosListPage> {
  const { prefix, marker, delimiter } = params
  const maxKeys = Math.max(1, Math.min(COS_MAX_KEYS, params.maxKeys ?? COS_MAX_KEYS))

  if (!cosConfigured()) {
    // 没配密钥 = 本地 demoMode，桶里确实什么都没有。如实返回空。
    return { objects: [], commonPrefixes: [], truncated: false, nextMarker: null }
  }

  const { cos, bucket, region } = await getCosClient()

  const data: any = await new Promise((resolve, reject) => {
    // 注意这里**没有 EncodingType**，理由见文件头。
    const req: Record<string, any> = {
      Bucket: bucket,
      Region: region,
      Prefix: prefix,
      MaxKeys: maxKeys
    }
    if (marker) req.Marker = marker
    if (delimiter) req.Delimiter = delimiter
    cos.getBucket(req, (err: any, res: any) => {
      if (err) reject(err)
      else resolve(res)
    })
  })

  const objects: CosObjectInfo[] = (data?.Contents ?? []).map((o: any) => ({
    key: String(o.Key),
    // SDK 给的是字符串；非数字（理论上不会）当 0，不让它变成 NaN 污染求和
    size: Number.isFinite(Number(o.Size)) ? Number(o.Size) : 0,
    lastModified: String(o.LastModified ?? ''),
    etag: String(o.ETag ?? ''),
    storageClass: String(o.StorageClass ?? '')
  }))

  const commonPrefixes: string[] = (data?.CommonPrefixes ?? [])
    .map((p: any) => String(p?.Prefix ?? ''))
    .filter(Boolean)

  const truncated = String(data?.IsTruncated) === 'true' || data?.IsTruncated === true

  // NextMarker 在设了 Delimiter 时可能不返回（分组后「最后一个对象」不唯一）。
  // 这时退回最后一页最后一个条目继续 —— COS 的 marker 语义是「严格大于」，
  // 所以从最后一个条目接着翻不会漏也不会重。
  let nextMarker: string | null = null
  if (truncated) {
    const fromResponse = data?.NextMarker ? String(data.NextMarker) : ''
    const lastEntry =
      objects.length > 0
        ? objects[objects.length - 1].key
        : commonPrefixes.length > 0
          ? commonPrefixes[commonPrefixes.length - 1]
          : ''
    nextMarker = fromResponse || lastEntry || marker || null
    // 极端情况下三者都空 → 无从继续，如实标成不可翻页而不是死循环
    if (!nextMarker) {
      return {
        objects,
        commonPrefixes,
        truncated: false,
        nextMarker: null,
        error: 'COS 说还有下一页，但没给出续传位置（无 NextMarker 也无末条目）'
      }
    }
  }

  return { objects, commonPrefixes, truncated, nextMarker }
}

/**
 * 把一个 prefix 下的对象全部列出来。
 *
 * **翻页中途失败不抛**，而是把已取到的部分连同 `incomplete: true` 一起返回。
 * 理由：部分数据比没有数据有用，但**危险程度完全不同**。抛异常的话调用方
 * 可能顺手 catch 掉然后继续用（项目里 deleteCosObject 就是这个「永不抛」
 * 的风格），于是「只拿到 1/40」被当成「全部」。返回 incomplete 让调用方
 * 显式处理，没有沉默的余地。
 */
export async function listAllCosObjects(params: {
  prefix: string
  maxPages?: number
  maxObjects?: number
}): Promise<CosListAll> {
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES
  const maxObjects = params.maxObjects ?? DEFAULT_MAX_OBJECTS

  const objects: CosObjectInfo[] = []
  let marker: string | undefined
  let pages = 0
  let incomplete = false
  let error: string | undefined

  while (pages < maxPages) {
    let page: CosListPage
    try {
      page = await listCosObjectsPage({ prefix: params.prefix, marker })
    } catch (e: any) {
      incomplete = true
      error = `第 ${pages + 1} 页列举失败：${e?.message || e}`
      break
    }
    pages++

    objects.push(...page.objects)
    if (page.error && !error) error = page.error
    if (page.error) incomplete = true

    if (!page.truncated) break

    if (objects.length >= maxObjects) {
      incomplete = true
      error = error || `对象数超过上限 ${maxObjects}，已停止翻页（请用更精确的 prefix 缩小范围）`
      break
    }
    marker = page.nextMarker ?? undefined
  }
  // 翻到页数上限还没翻完 —— 也是「没覆盖全」
  if (pages >= maxPages && !error) {
    incomplete = true
    error = `超过翻页上限 ${maxPages} 页，结果不完整`
  }

  return { objects, incomplete, error, pages }
}

/**
 * 列一个用户命名空间下的**全部**对象（两个前缀都扫）。
 *
 * 为什么按 `FILE_KEY_PREFIXES` 遍历而不是硬编码某一个：仓库里有两处构造 key，
 * 形状不同（`users/<id>/…` 与 `u/<id>/…`），再加第三处时这里会自动跟上 ——
 * 而漏掉一个前缀的表现是「那个前缀下的对象全都不见了」，很难注意到。
 */
export async function listUserNamespaceObjects(
  userId: number,
  prefixes: readonly string[]
): Promise<CosListAll> {
  const merged: CosObjectInfo[] = []
  const errors: string[] = []
  let incomplete = false
  let pages = 0

  for (const prefix of prefixes) {
    const res = await listAllCosObjects({ prefix: `${prefix}/${userId}/` })
    merged.push(...res.objects)
    pages += res.pages
    if (res.incomplete) {
      incomplete = true
      if (res.error) errors.push(`${prefix}/: ${res.error}`)
    }
  }

  return {
    objects: merged,
    incomplete,
    error: errors.length ? errors.join('；') : undefined,
    pages
  }
}