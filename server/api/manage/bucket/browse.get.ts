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
import { userKeyPrefixes } from '~~/server/utils/bucket-admin'

/** 单次最多列多少。COS 硬上限 1000，这里留一半余量给分页条数 */
const PAGE_SIZE = 100

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const q = getQuery(event)
  const userId = Number(q?.userId)
  const marker = q?.marker ? String(q.marker) : undefined
  // delimiter 传 'dir' 才按目录分组。默认不分组（直接列文件）
  const delimiter = q?.group === 'dir' ? '/' : undefined

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: '缺少合法的 userId' })
  }

  const allPrefixes = userKeyPrefixes(userId)

  // 用哪一个命名空间由客户端显式点名，服务端只负责校验它确实是这个用户的。
  //
  // 原来的写法是 `prefixes[0] + '/'`，那永远只会列 `users/<id>/`，`u/<id>/`
  // 下（复制产生的文件）一个都看不到，而且**没有任何提示** —— 界面上就是
  // 「这个用户只有这些文件」。那正是 FILE_KEY_PREFIXES 存在的理由要防的：
  // 漏掉一个前缀的表现是「那个前缀下的对象全都不见了」，很难注意到。
  const requested = q?.prefix ? String(q.prefix) : ''
  const prefix = allPrefixes.find((p) => p === requested)
  if (!prefix) {
    // 不 fallback 到第一个：默认选一个会让「忘了传」与「选错了」长得一模一样
    throw createError({
      statusCode: 400,
      message: '缺少或非法的 prefix',
      data: { allowed: allPrefixes }
    })
  }

  // 这里**会 throw**：列举失败必须让调用方知道，否则「空的」和「列不出来」
  // 分不开，而前者会让人以为这个用户真的什么都没有。
  const page = await listCosObjectsPage({ prefix, marker, maxKeys: PAGE_SIZE, delimiter })

  return {
    prefix,
    objects: page.objects,
    commonPrefixes: page.commonPrefixes,
    truncated: page.truncated,
    nextMarker: page.nextMarker,
    error: page.error,
    allPrefixes
  }
})