// /api/manage/bucket/browse —— 只读地浏览桶里的对象。
//
// 与 reconcile 的区别：那个做比对（要列全、可能翻很多页），这个只翻**一页**
// 给界面下钻。两个分开的端点而不是加个 query flag —— 因为两者的失败语义
// 完全相反（见下），一个 flag 会让「列举坏了」和「列举到一半坏了」共用到
// 同一个字段上，而它们该有的处置是相反的。
//
// 分页时**不设 EncodingType**，理由见 server/utils/cos-list.ts 文件头。
import { defineEventHandler, getQuery, createError } from 'h3'
import { requireSuperAdmin } from '~~/server/utils/auth-middleware'
import { listCosObjectsPage } from '~~/server/utils/cos-list'
import { cosConfigured } from '~~/server/utils/cos'
import { userKeyPrefixes } from '~~/server/utils/bucket-admin'

/** 单次最多列多少。COS 硬上限 1000，这里留一半余量给分页条数 */
const PAGE_SIZE = 100

/**
 * 前缀长度上限。
 *
 * COS 的 key 是扁平字符串，理论上多长都能当前缀用。但 prefix 走的是 URL
 * 查询参数，长度不受这里的约束就等于让调用方往 URL 里塞一兆字节 ——
 * 列举还照样工作，失败发生在更靠前的、看不出原因的地方。
 */
const MAX_PREFIX_LEN = 1024

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const q = getQuery(event)

  // 前缀是**任意**字符串，空 = 整个桶。
  //
  // 原来是 `allPrefixes.find((p) => p === requested)`：必须精确等于该用户的
  // 某个命名空间，否则 400。那个精确匹配挡的是一个具体的坑 —— 早先写成
  // `prefixes[0] + '/'`，于是永远只列 users/<id>/，u/<id>/ 下的对象一个都
  // 看不到，且没有任何提示：界面上就是「这个用户只有这些文件」。
  //
  // 放开是刻意的：能进这一页的是超管，腾讯云的秘钥就在服务端配置里，
  // 也就是说这个操作者本来就能对整个桶做任何事。为了看一个对象而要求他
  // 先选中一个用户、再从两个命名空间里挑一个，是把限制加在错的地方 ——
  // 真正该拦住的是「不是超管」，而那在 requireSuperAdmin 里已经拦了。
  //
  // 代价是「看错范围」的风险从服务端回到了界面，所以替代品是两条：
  //   ① 响应回显 prefix，页面把它原样完整显示（不是显示成「用户 2 的文件」）
  //   ② userId 一旦传了就必须合法（下面）—— 拼错它不能被静默当成「没传」，
  //      因为那会把范围从「某人的两个命名空间之一」悄悄放大成「整个桶」，
  //      比原来那个只列一半的 bug 更难发现
  const prefix = q?.prefix ? String(q.prefix) : ''

  if (prefix.length > MAX_PREFIX_LEN) {
    throw createError({
      statusCode: 400,
      message: `前缀过长（${prefix.length} > ${MAX_PREFIX_LEN}）`
    })
  }

  const marker = q?.marker ? String(q.marker) : undefined
  // delimiter 传 'dir' 才按目录分组。默认不分组（直接列文件）
  const delimiter = q?.group === 'dir' ? '/' : undefined

  // userId 可选：它只用来顺带返回该用户的命名空间快捷方式（allPrefixes），
  // 不参与决定列举范围 —— 范围只由 prefix 说。
  //
  // 「传了就必须合法」是上面那条替代品②。原来的写法是必需的 userId，
  // 非法就 400；现在不能改成「非法就当没传」，理由同上。
  const hasUserId = q?.userId !== undefined && q?.userId !== null && q?.userId !== ''
  const userId = hasUserId ? Number(q.userId) : null
  if (hasUserId && (!Number.isSafeInteger(userId) || userId! <= 0)) {
    throw createError({ statusCode: 400, message: 'userId 不是合法的正整数' })
  }

  const allPrefixes = userId ? userKeyPrefixes(userId) : []

  // 这里**会 throw**：列举失败必须让调用方知道，否则「空的」和「列不出来」
  // 分不开，而前者会让人以为这个用户真的什么都没有 —— 在空前缀（整桶）下
  // 就是「以为整个桶是空的」，那比原来严重得多。
  const page = await listCosObjectsPage({ prefix, marker, maxKeys: PAGE_SIZE, delimiter })

  return {
    prefix,
    objects: page.objects,
    commonPrefixes: page.commonPrefixes,
    truncated: page.truncated,
    nextMarker: page.nextMarker,
    error: page.error,
    allPrefixes,
    // 没配密钥时 listCosObjectsPage 如实返回空列表且**不带 error**（demoMode
    // 下桶里确实什么都没有，这没说错）。可在这一页默认列的是整个桶，
    // 于是「没有凭据」与「桶真的空了」在界面上会长得一模一样。
    // 把这个事实报上去，界面才说得出差别 —— 而不是让操作者以为整个桶是空的。
    // 兄弟页 bucket.vue 就是缺这一条：它的 cosConfigured 是 ref(true) 且从
    // 没被赋成 false，那条横幅因此永远不会出现。
    cosConfigured: cosConfigured()
  }
})
