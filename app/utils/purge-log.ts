/**
 * 解读存储桶清理审计的载荷（bucket_purge_log.payload）。
 *
 * ## 为什么单独一个文件
 *
 * 这是一段纯数据变换 —— 字符串进、给人看的条目出，不碰 Vue、不碰 DOM。
 * 放在 .vue 里就只能靠正则断言源码，而正则测不出「两种 kind 形状不同」
 * 「载荷坏掉时不能显示成空」这些真正要命的地方。
 *
 * ## 两种 kind 的形状真的不一样
 *
 * payload 是 JSON 快照，两种删除写进去的东西不同：
 *
 *   dangling-row（删数据库行）
 *     { id, fileKey, filename, folderId, fileSize, createdAt }
 *     带原文件名和**原来在哪个文件夹**。用户投诉「我上周一个文件不见了」时，
 *     这是唯一拿得出的证据 —— 对象已经不在了，那一行也没了。
 *
 *   orphan-object（删 COS 对象）
 *     { key }
 *     只有 key。没有大小、没有时间：端点只收到 key，删前没测大小，
 *     所以清理历史的 bytes 对孤儿对象恒为 0（见 server/api/manage/bucket/purge-orphans.post.ts）。
 *     key 里**可能**带原名（u/<id>/…_<原名> 那种形状），但那不是这个模块能保证的，
 *     所以这里不猜、不显示成文件名。
 *
 * ## 解不开怎么办
 *
 * 如实说解不开，**不返回空数组**。载荷是这份审计里唯一不可再生的东西
 * （对象和行都删了，只剩这份 JSON）。界面上把它渲染成空，等于告诉操作者
 * 「这次没删过什么」—— 那比报错糟得多。
 */
import { formatFileSize } from '~/utils/format'

/** 一条审计。字段与 server/utils/bucket-admin.ts 的 listPurgeLog 选出的一致 */
export interface PurgeLogRow {
  id: number
  kind: 'orphan-object' | 'dangling-row'
  userId: number
  count: number
  bytes: number
  /** 谁删的。审计表的全部意义就在这一列 */
  actorId: number
  /** JSON 字符串，两种 kind 的形状不同，解开后才能给人看 */
  payload: string
  createdAt: string
}

/** 解开后的单条。两种 kind 携带的信息量不同，不假装它们一样 */
export interface PurgeItem {
  key: string
  note: string
}

/** 载荷解不开时返回的那一条。用固定文案，便于测试与识别 */
export const UNREADABLE_PAYLOAD_NOTE = '审计载荷无法解析（原文保留在数据库里，未丢弃）'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// 字节数一律走 format.ts 的 formatFileSize。
// 第一版这里自己写了一个，阈值行为和它不一样（1024 → 「1.0 KB」vs「1 KB」），
// 于是同一张页面上审计表和孤儿表对同一个大小显示两种字符串。
//
// 用 `~/utils/format` 而不是 `./format`：zipper.ts 用的是后者。两种在真实构建里
// 都能跑（Vite 补扩展名），但 tests/helpers/resolve-nuxt-alias.mjs 只拦
// ~~/ 与 ~/ 两个别名，相对路径直接放行 —— 于是 `./format` 在测试里是
// ERR_MODULE_NOT_FOUND。zipper.ts 一直没被测，所以这个洞此前没暴露。
// datetimeLocal.ts 引 ~/utils/time 就是这个理由。


/**
 * 解开一条审计的载荷。
 *
 * 任何形状不认识都产出一个 note 说清「不认识」，而不是静默丢掉 —— 丢一条
 * 就等于让审计少一条，而审计的价值恰恰在于「不会空、不会漏」。
 */
export function purgeItems(log: Pick<PurgeLogRow, 'payload'>): PurgeItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(log.payload)
  } catch {
    return [{ key: '', note: UNREADABLE_PAYLOAD_NOTE }]
  }
  if (!Array.isArray(parsed)) {
    return [{ key: '', note: '审计载荷不是数组（原文保留在数据库里）' }]
  }

  return parsed.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>

    // orphan-object：{ key }
    const bareKey = str(r.key)
    if (bareKey !== null) {
      return { key: bareKey, note: '对象存储里的对象' }
    }

    // dangling-row：整个 files 行
    const rowKey = str(r.fileKey)
    if (rowKey !== null) {
      const bits: string[] = []
      const name = str(r.filename)
      if (name !== null) bits.push(`原文件名「${name}」`)
      const folderId = num(r.folderId)
      if (folderId !== null) bits.push(`原属文件夹 #${folderId}`)
      const size = num(r.fileSize)
      if (size !== null) bits.push(formatFileSize(size))
      const createdAt = str(r.createdAt)
      // 标 UTC：DB 里存的是 SQLite CURRENT_TIMESTAMP，即 UTC 墙钟。
      // 这里只展示不换算（换算交给页面的 formatTime），不标的话看的人
      // 会把它当本地时间。
      if (createdAt !== null) bits.push(`创建于 ${createdAt} UTC`)
      return { key: rowKey, note: bits.length ? bits.join(' · ') : '数据库行（无附加信息）' }
    }

    return { key: '', note: '未知的载荷形状' }
  })
}
