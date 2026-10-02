import { defineEventHandler, getQuery, readBody } from 'h3'
import COS from 'cos-nodejs-sdk-v5'
import { useRuntimeConfig } from '#imports'
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService, FolderService } from '~~/server/utils/db'
import type { OwnedFile, OwnedFolder } from '~~/server/utils/db'
import { ensurePaths } from '~~/server/utils/folders'
import { resolveUniqueFilename } from '~~/server/utils/file'
import { uniqPositiveInts } from '~~/server/utils/functions'
import {
  linkGrantsFile,
  linkGrantsFolder,
  listSubtreeByLink,
  resolveLinkTarget
} from '~~/server/utils/share-link'
import { skipAndOverwriteError } from '~~/types/error'
import { quotaFailMessage } from '~~/server/utils/quota'
import {
  chainExpired,
  releaseStorage,
  resolveQuotaChain,
  reserveStorage
} from '~~/server/utils/sub-account'
import { DEFAULT_SHARE_MODE, hasPermission, normalizeShareLink, PERM_WRITE } from '~~/types/share'

function sanitizeForKey(name: string): string {
  return name.replace(/[\\?%*:|"<>]/g, '_').replace(/[\s]+/g, ' ')
}
function randomId(len = 10) {
  return Math.random().toString(36).slice(2, 2 + len)
}

export default defineEventHandler(async (event) => {
  /**
   * 分享链接视图下的复制。
   *
   * link 只换掉**源**的解析方式，目标目录判定一行都没动（仍然是
   * findAccessibleById(authId, targetFolderId, PERM_WRITE)）。这条边界不能松：
   * 链接只给只读，它唯一该做的事是「让我把看到的东西拷进自己的空间」，
   * 绝不能变成「让我往属主的树里写」。副本一律落在目标目录的属主树下。
   *
   * 源的两处判定都要换：
   *   - 单个条目：按人查名单（findAccessibleMany + PERM_WRITE）→ 按 token 查边界（linkGrants*）
   *   - 子树：逐层 resolveAccess + PERM_WRITE → listSubtreeByLink 的 ok 标志（只收继承态）
   * 不复用 findAccessibleMany 的理由与 share-link.ts 顶部一致：那是按 userId 查
   * file_access/folder_access 的，链接没有 userId，查询形状不同。
   */
  const shareLink = normalizeShareLink((getQuery(event) as any)?.link)

  // 中间件不在 LINK_PUBLIC_PATHS 里放行本接口，所以链接复制仍然要求登录：
  // 复制是写操作，要有个身份来承担空间额度和「副本归谁」。
  const { authUserId } = await getMeAndTarget(event)
  // 鉴权身份：判「我能不能读这些 / 能不能往那儿写」
  const authId = Number(authUserId)
  const db: any = getDb(event)
  if (!db) return { success: false, statusMessage: '数据库连接失败' }

  const body = await readBody<{
    targetFolderId: number | null
    folderIds?: number[]
    fileIds?: number[]
    overwrite?: boolean | null
    skipIfExist?: boolean | null
  }>(event)

  if (body.overwrite && body.skipIfExist) throw skipAndOverwriteError

  const targetFolderId = (body?.targetFolderId ?? null) as number | null
  const folderIds = uniqPositiveInts(body?.folderIds || [])
  const fileIds = uniqPositiveInts(body?.fileIds || [])

  if (!folderIds.length && !fileIds.length) {
    return { success: true, copied: { folders: 0, files: 0 }, skipped: 0, failed: 0, statusMessage: '无复制项' }
  }

  const fileService = new FileService(db)
  const folderService = new FolderService(db)

  // 复制源：要求 **WRITE**，不只是读得到。
  // 规则是「能原地改的才允许拷走」：只读授权的内容不会被搬进自己的空间，
  // 否则属主事后撤掉授权也追不回来。子树内的子目录/文件同规则（见 collectSubtree）。
  //
  // 链接分支例外：链接只给 READ|DOWNLOAD，本来就永远过不了上面那条 WRITE，
  // 所以走 linkGrants*（只要求覆盖得到）。这是有意的 —— 链接是长期凭据，
  // 拷走之后收不回来，但整包下载本来就能把同样的字节拿走，不算新的暴露面。
  let movedFolders: OwnedFolder[]
  let movedFileRows: OwnedFile[]
  /** 链接解析出来的属主。子树的 SQL 要用它圈 user_id 范围 */
  let linkOwnerId: number | null = null
  try {
    if (shareLink) {
      const target = await resolveLinkTarget(db, shareLink)
      linkOwnerId = target.ownerId

      // 逐个验「这条 token 能不能覆盖它」。链接视角下列表只给继承态子项，
      // 但 body 里的 id 是客户端给的，不能因为「列表里出现过」就信。
      const okFolders: OwnedFolder[] = []
      for (const id of folderIds) {
        if (!(await linkGrantsFolder(db, shareLink, id))) continue
        const row = await folderService.findOwnedById(linkOwnerId, id)
        if (row) okFolders.push(row)
      }
      const okFiles: OwnedFile[] = []
      for (const id of fileIds) {
        if (!(await linkGrantsFile(db, shareLink, id))) continue
        const row = await fileService.findOwnedById(linkOwnerId, id)
        if (row) okFiles.push(row)
      }
      // 少一个就整体拒绝，不做部分成功 —— 否则会出现「搬了一半」的中间态，
      // 与 findAccessibleMany 的口径一致。
      if (okFolders.length !== folderIds.length || okFiles.length !== fileIds.length) {
        return { success: false, statusMessage: '部分内容不存在，或不在该分享链接的范围内' }
      }
      movedFolders = okFolders
      movedFileRows = okFiles
    } else {
      movedFolders = await folderService.findAccessibleMany(authId, folderIds, PERM_WRITE)
      movedFileRows = await fileService.findAccessibleMany(authId, fileIds, PERM_WRITE)
    }
  } catch (e: any) {
    return { success: false, statusMessage: e?.statusMessage || '部分内容不存在或无权限' }
  }

  // 目标目录：要 write。原来只有 findOwnedById(userId)，
  // 普通用户传 targetUserId 就能往别人树里粘贴。
  let destOwnerId: number | null
  if (targetFolderId !== null) {
    try {
      const dest = await folderService.findAccessibleById(authId, targetFolderId, PERM_WRITE)
      destOwnerId = dest.userId
    } catch (e: any) {
      return { success: false, statusMessage: e?.statusMessage || '目标文件夹不存在或无权限' }
    }
  } else {
    /**
     * 根层 = **请求者自己的**根（authUserId：useAdmin 时是 targetUserId，
     * 否则是我自己）。
     *
     * 原来这里 destOwnerId 留空，userId 落到「源的属主」头上，等于
     * 「不校验目标」：把别人分享给我的文件粘到根目录，会在对方根目录里
     * 插一条记录、额度也扣对方账上。现在根层归属明确是我自己，
     * 跨用户复制就是「复制到我的文件」，语义也对上了。
     */
    destOwnerId = authId
  }

  /**
   * 树属主：下面所有 owner-scoped SQL 用它，不是 authId。
   * 副本永远落在**目标目录的属主**树里（不是源的属主）—— 复制到别人树里
   * 时副本归对方，这是分享语义下唯一自洽的解释。
   */
  const userId = destOwnerId

  // 拉取待复制的单个文件列表（包含复制所需字段）
  type SrcFile = {
    id: number
    filename: string
    folderId: number | null
    fileKey: string
    fileSize: number
    contentType: string | null
  }
  const movedFiles: SrcFile[] = movedFileRows.map((r) => ({
    id: r.id,
    filename: r.filename,
    folderId: r.folderId,
    fileKey: r.fileKey,
    fileSize: r.fileSize,
    contentType: r.contentType
  }))
  if (movedFiles.length !== fileIds.length) {
    return { success: false, statusMessage: '部分文件不存在或无权限' }
  }

  // 准备：收集 folder 子树的所有子目录与文件，并生成相对路径
  const CHUNK = 500
  const pathsToEnsure = new Set<string>() // e.g. "A", "A/B"
  const relPathByFolderId = new Map<number, string>() // folderId -> "A/B"
  const filesFromFolders: SrcFile[] = []
  const filesFromFoldersSet = new Set<number>()

  /**
   * 广度优先收集一棵子树：子目录 + 里面的文件，并生成相对路径。
   *
   * `sourceOwnerId` 必须是**源树的属主**，不是目标属主。两个枚举方法
   * （listChildrenByParentIds / listByFolders）都是 `WHERE user_id = ?` 硬限定，
   * 拿目标属主去查别人的树，恒返回空 —— 于是「文件夹复制过来了、子项全没了」。
   *
   * 收录条件是 **PERM_WRITE**，不是 READ：能原地改的才允许拷走。只读授权的内容
   * 不会被搬进自己的空间，否则属主撤掉授权也追不回来了。顺带也保证不会把
   * 别人树里不可见的子树（SHARE_NONE / 私人文件）一并带出去。
   *
   * **链接视角不走这里**，见下面 collectSubtreeByLink —— 那条用 listSubtreeByLink，
   * 和整包下载清单同一个收集器，不写第二套遍历。
   */
  async function collectSubtree(rootId: number, rootName: string, sourceOwnerId: number) {
    relPathByFolderId.set(rootId, rootName)
    pathsToEnsure.add(rootName)

    const subtree = new Set<number>([rootId])
    let frontier: number[] = [rootId]
    while (frontier.length > 0) {
      const children = await folderService.listChildrenByParentIds(sourceOwnerId, frontier)
      const next: number[] = []
      for (const c of children) {
        if (subtree.has(c.id)) continue
        const access = await folderService.resolveAccess(authId, c.id)
        if (!hasPermission(access.mask, PERM_WRITE)) continue
        subtree.add(c.id)
        const parentPath = relPathByFolderId.get(c.parentId ?? -1) || ''
        const myPath = parentPath ? `${parentPath}/${c.name}` : c.name
        relPathByFolderId.set(c.id, myPath)
        pathsToEnsure.add(myPath)
        next.push(c.id)
      }
      frontier = next
    }

    // 收集该子树中的所有文件（带 key/size/type）。按所在目录分组，
    // 每组只解析一次目录掩码，避免每个文件跑一次上行 CTE。
    const ids = Array.from(subtree)
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK)
      const list = await fileService.listByFoldersWithGrants(sourceOwnerId, batch)
      const byFolder = new Map<number, OwnedFile[]>()
      for (const f of list) {
        const key = f.folderId ?? -1
        if (!byFolder.has(key)) byFolder.set(key, [])
        byFolder.get(key)!.push(f)
      }
      for (const [folderId, group] of byFolder) {
        const dirAccess = await folderService.resolveAccess(authId, folderId)
        const writable = await fileService.filterAccessible(authId, group, dirAccess, PERM_WRITE)
        for (const f of writable) {
          filesFromFolders.push({
            id: f.id,
            filename: f.filename,
            folderId: f.folderId,
            fileKey: f.fileKey,
            fileSize: f.fileSize,
            contentType: f.contentType
          })
          filesFromFoldersSet.add(f.id)
        }
      }
    }
  }

  /**
   * 链接视角的子树收集：**复用 listSubtreeByLink**（整包下载清单用的同一个），
   * 不写第二套遍历。
   *
   * 它已经按链接语义过滤好了：非继承节点（自己那道边界）往下整支清零，
   * 文件还要 Shared = 继承。于是「墙后面的东西」不会被搬走。
   *
   * 它**不返回目录**，所以空目录会丢 —— 整包下载同样丢，是既有行为。
   * 目录骨架从 relDir 切出来补齐。
   *
   * 注意 relDir 是**相对子树根**的（listSubtreeByLink 的 CTE 从 rootId 起算，
   * 起点那层是空串），而 relPathByFolderId / pathsToEnsure 认的路径是
   * **相对粘贴目标**的（collectSubtree 里根目录记的是自己的名字）。所以要补上
   * rootName 前缀，否则查回落点时拿到 "sub" 而不是 "A/sub"，文件会落错目录。
   */
  async function collectSubtreeByLink(rootId: number, rootName: string, ownerId: number) {
    relPathByFolderId.set(rootId, rootName)
    pathsToEnsure.add(rootName)

    const scoped = await listSubtreeByLink(db, ownerId, rootId)
    for (const f of scoped.files) {
      const relDir = String(f.relDir || '').replace(/^\/+|\/+$/g, '')
      const rel = relDir ? `${rootName}/${relDir}` : rootName
      // 补齐每一级祖先："A/B/C" → "A"、"A/B"、"A/B/C"
      const segs = rel.split('/').filter(Boolean)
      for (let i = 1; i <= segs.length; i++) {
        pathsToEnsure.add(segs.slice(0, i).join('/'))
      }
      // 文件所在目录也要能查回落点：relPathByFolderId 认的是目录 id，
      // 而 ManifestFile 正好带了 folderId
      if (f.folderId != null) relPathByFolderId.set(f.folderId, rel)
      filesFromFolders.push({
        id: f.id,
        filename: f.filename,
        folderId: f.folderId,
        fileKey: f.fileKey,
        fileSize: f.fileSize,
        contentType: f.contentType ?? null
      })
      filesFromFoldersSet.add(f.id)
    }
  }

  for (const f of movedFolders) {
    if (shareLink) {
      // 链接的属主是 resolveLinkTarget 给的，不是 f.userId 的逐条反查 ——
      // 子树里每一行本来就同属主，用一个值圈范围就够了。
      await collectSubtreeByLink(f.id, f.name, linkOwnerId!)
    } else {
      // f.userId = 源目录的属主。剪贴板里混了多个属主的条目也各走各的。
      await collectSubtree(f.id, f.name, f.userId)
    }
  }

  // 在目标位置创建/复用需要的目录（含空目录）
  const destMap = await ensurePaths(db, userId, {
    parentId: targetFolderId,
    paths: Array.from(pathsToEnsure),
  })

  // 生成复制计划（来自文件夹子树 + 额外指定的单个文件）
  type DupInfo = { id: number, fileKey: string, fileSize: number }
  type PlanItem = {
    src: SrcFile
    destFolderId: number | null
    finalFilename: string
    overwriteExisting?: DupInfo
  }
  const plan: PlanItem[] = []

  // 子树的文件
  for (const f of filesFromFolders) {
    const rel = relPathByFolderId.get(f.folderId ?? -1) || ''
    const destFolderId = rel ? (destMap[rel] ?? null) : targetFolderId
    plan.push({
      src: f,
      destFolderId,
      finalFilename: f.filename
    })
  }
  // 额外选中的单个文件（排除已在子树内的）
  for (const f of movedFiles) {
    if (filesFromFoldersSet.has(Number(f.id))) continue
    plan.push({
      src: f,
      destFolderId: targetFolderId,
      finalFilename: f.filename
    })
  }

  // 查重复工具
  async function findDup(destFolderId: number | null, filename: string): Promise<DupInfo | null> {
    const row = await fileService.findByName(userId, destFolderId, filename)
    if (!row) return null
    return { id: row.id, fileKey: row.fileKey, fileSize: row.fileSize }
  }

  // 冲突处理：skip/overwrite/rename（并顺便计算净新增空间）
  const toCopy: PlanItem[] = []
  let bytesToCopy = 0
  let bytesToFreeByOverwrite = 0

  for (const item of plan) {
    const { src, destFolderId } = item

    // 若目标与源是同一 folder 且同名，按“复制”语义不允许覆盖源：优先改名
    const dup = await findDup(destFolderId, item.finalFilename)

    if (dup) {
      if (body?.skipIfExist) {
        // 跳过
        continue
      } else if (body?.overwrite) {
        // 先计划复制（成功后删除旧记录与对象）
        toCopy.push({ ...item, overwriteExisting: dup })
        bytesToCopy += src.fileSize
        bytesToFreeByOverwrite += dup.fileSize
      } else {
        // 默认：改名
        const { name: unique } = await resolveUniqueFilename(db, userId, destFolderId, item.finalFilename)
        toCopy.push({ ...item, finalFilename: unique })
        bytesToCopy += src.fileSize
      }
    } else {
      // 无冲突
      toCopy.push(item)
      bytesToCopy += src.fileSize
    }
  }

  // 原子预占空间（净新增：复制总和 - 覆盖释放）
  const reserveBytes = Math.max(0, bytesToCopy - bytesToFreeByOverwrite)

  /**
   * 预占空间。过期与容量按**整条链**判：userId 是子账户时，
   * 主账号的池也参与，两层在同一条 UPDATE 里。
   *
   * 过期判定放在 `if (reserveBytes > 0)` 之外：净增为 0 的纯覆盖
   * （目标目录里已有同名同大小的文件）原来会整段跳过判据 ——
   * 过期账号只要满足这个条件就能一直覆盖复制下去。
   */
  const quotaChain = await resolveQuotaChain(db, userId)
  const expiredOn = await chainExpired(db, quotaChain)
  if (expiredOn.self || expiredOn.parent) {
    return {
      success: false,
      statusMessage: await quotaFailMessage(db, expiredOn.self ? 'expired_self' : 'expired_parent', userId, null, false)
    }
  }

  if (reserveBytes > 0) {
    const fail = await reserveStorage(db, quotaChain, reserveBytes)
    if (fail) {
      return { success: false, statusMessage: await quotaFailMessage(db, fail, userId, null, false) }
    }
  }

  // COS 客户端
  const config = useRuntimeConfig()
  const cos = new COS({
    SecretId: config.tencentSecretId,
    SecretKey: config.tencentSecretKey,
    // 可选：启用加速域名等参数
  })
  const Bucket = config.cosBucket
  const Region = config.cosRegion
  const MAX_CONCURRENCY = config.maxConcurrency

  function cosCopyObject(srcKey: string, destKey: string): Promise<any> {
    const CopySource = `${Bucket}.cos.${Region}.myqcloud.com/${encodeURIComponent(srcKey)}`
    return new Promise((resolve, reject) => {
      cos.sliceCopyFile(
        { Bucket, Region, Key: destKey, CopySource },
        (err, data) => (err ? reject(err) : resolve(data))
      )
    })
  }
  function cosDeleteObject(key: string): Promise<void> {
    return new Promise((resolve) => {
      cos.deleteObject({ Bucket, Region, Key: key }, () => resolve())
    })
  }
  function buildCosKey(userId: number, filename: string) {
    const safe = sanitizeForKey(filename)
    const y = new Date()
    const day = `${y.getUTCFullYear()}-${(y.getUTCMonth()+1).toString().padStart(2,'0')}-${y.getUTCDate().toString().padStart(2, '0')}`
    return `u/${userId}/${day}/${Date.now()}_${randomId(6)}_${safe}`
  }
  function buildCosUrl(key: string) {
    return `https://${Bucket}.cos.${Region}.myqcloud.com/${encodeURIComponent(key)}`
  }

  // 并发池
  async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]> {
    const ret: R[] = new Array(items.length) as R[]
    let i = 0
    let active = 0
    let resolveAll: (v: R[]) => void
    let rejectAll: (e: any) => void
    const done = new Promise<R[]>((resolve, reject) => { resolveAll = resolve; rejectAll = reject })
    const next = () => {
      while (active < limit && i < items.length) {
        const cur = i++
        active++
        worker(items[cur], cur)
          .then((r) => { ret[cur] = r })
          .catch((e) => { rejectAll(e) })
          .finally(() => {
            active--
            if (ret.length === items.length && active === 0 && i >= items.length) {
              resolveAll(ret)
            } else {
              next()
            }
          })
      }
      if (items.length === 0) resolveAll(ret)
    }
    next()
    return done
  }

  // 执行复制任务（含写库和 overwrite 删除旧文件记录）
  let copiedFiles = 0
  let skipped = plan.length - toCopy.length
  let failed = 0
  let successCopyBytes = 0
  let successFreedBytes = 0

  type CopyTask = {
    item: PlanItem
    destKey: string
    destUrl: string
  }
  const tasks: CopyTask[] = toCopy.map((p) => {
    const destKey = buildCosKey(userId, p.finalFilename)
    const destUrl = buildCosUrl(destKey)
    return { item: p, destKey, destUrl }
  })

  try {
    await runWithConcurrency(tasks, MAX_CONCURRENCY, async (task) => {
      const { item, destKey, destUrl } = task
      const { src, destFolderId, finalFilename, overwriteExisting } = item

      // 复制对象（COS 内部快速 Copy）
      await cosCopyObject(src.fileKey, destKey)

      // 成功后写入文件记录
      const contentType = src.contentType || 'application/octet-stream'
      const ins = await db
        .prepare('INSERT INTO files (user_id, folder_id, filename, file_key, file_size, file_url, content_type, Shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, destFolderId, finalFilename, destKey, src.fileSize, destUrl, contentType, DEFAULT_SHARE_MODE)
        .run()
      copiedFiles++
      successCopyBytes += src.fileSize

      // 若 overwrite：复制成功后再删除旧记录与旧对象（避免先删导致失败后数据丢失）
      if (overwriteExisting) {
        await fileService.deleteOwned(userId, overwriteExisting.id)
        // 尝试删除旧对象（失败忽略，避免影响整体）
        if (overwriteExisting.fileKey && overwriteExisting.fileKey !== destKey) {
          await cosDeleteObject(overwriteExisting.fileKey).catch(() => {})
        }
        successFreedBytes += overwriteExisting.fileSize
      }
    })
  } catch (e: any) {
    // 并发复制过程中任一出错，统计失败数 = 余下未成功的任务数
    failed = tasks.length - copiedFiles
  }

  // 调整 usedStorage：预占是 reserveBytes，真实净增是 successCopyBytes - successFreedBytes
  const actualNet = Math.max(0, successCopyBytes - successFreedBytes)
  const delta = reserveBytes - actualNet
  if (delta > 0) {
    // 退还多占的空间
    await db.prepare('UPDATE users SET usedStorage = MAX(0, usedStorage - ?) WHERE id = ?').bind(delta, userId).run()
  } else if (delta < 0) {
    // 理论不应出现（实际比预占更多），兜底加上
    await db.prepare('UPDATE users SET usedStorage = usedStorage + ? WHERE id = ?').bind(-delta, userId).run()
  }

  // 最终兜底重算（一致性保障）
  await fileService.recalculateUsedStorage(userId)

  return {
    success: failed === 0,
    // folders 记的是「请求复制了几个文件夹」，不是「实际建了几个」——
    // 链接分支下空目录不会建（见 collectSubtreeByLink），所以这个数会偏大。
    // 与非链接分支的既有口径保持一致，不在这里另算一套。
    copied: { folders: folderIds.length, files: copiedFiles },
    skipped,
    failed,
    statusMessage: failed ? '部分文件复制失败' : '复制完成'
  }
})