// server/api/files/index.get.ts
import { getMeAndTarget, optionalAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { FileService, FolderService } from '~~/server/utils/db'
import type { PermSource, ResolvedAccess, SharedEntry } from '~~/server/utils/db'
import {
  listChildrenByLink,
  linkGrantsFile,
  linkGrantsFolder,
  LINK_ACCESS,
  linkNotActiveMessage,
  resolveLinkTarget
} from '~~/server/utils/share-link'
import {
  hasPermission,
  normalizeShareLink,
  PERM_ALL,
  PERM_DOWNLOAD,
  PERM_READ,
  PERM_WRITE,
  SHARE_SHARED
} from '~~/types/share'
import { getQuery } from 'h3'

/**
 * 分享链接视角的列表。与登录态完全无关，也没有任何权限参数可调 ——
 * 权限锁死 LINK_PERMISSION，ownerId 是内容的属主（前端据此判断能不能改，
 * 对匿名访问者来说恒为 false）。
 *
 * 三种落点：
 *   不给 folderId + 链接挂在文件上 → 那个文件单列一行（复用列表渲染）
 *   不给 folderId + 链接挂在目录上 → 该目录的内容
 *   给了 folderId                  → 该目录的内容，但先要 token 真能覆盖它
 *
 * 子项一律只给继承态的：任何非继承子节点都是它自己那道边界，链接到不了。
 */
async function listByLink(db: any, link: string, rawFolderId?: string, actingUserId: number | null = null) {
  const target = await resolveLinkTarget(db, link)
  // 死链提示分访客/属主两套：匿名访客改不了任何设置，告诉他「去设为分享」没用
  const notActive = linkNotActiveMessage(actingUserId, target.ownerId)
  const folderService = new FolderService(db)
  const fileService = new FileService(db)

  const tag = <T extends { userId: number }>(rows: T[]) =>
    rows.map((r) => ({
      ...r,
      ownerId: r.userId,
      perm: LINK_ACCESS.perm,
      permSource: LINK_ACCESS.permSource,
      canWrite: false
    }))

  let folderId: number | null = null
  if (rawFolderId && rawFolderId !== 'root' && rawFolderId !== '0') {
    const parsed = Number(rawFolderId)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw createError({ statusCode: 400, message: '非法的 folderId' })
    }
    folderId = parsed
  }

  // 链接直接挂在文件上：把那个文件作为唯一一项交出去。
  // 不包装成「只含一个文件的目录」—— 那样面包屑会显示成一个假目录。
  if (folderId === null && target.type === 'file') {
    const file = await fileService.findOwnedById(target.ownerId, target.id)
    // **必须验链接真能覆盖这个文件**，不能只看文件在不在。
    // 文件自己不是边界时（Shared=继承），挂上去的链接是死的 —— 但只要文件存在，
    // 这里原来就直接返回了，于是死链照样能匿名列出来。
    // 而 /api/files/download 走 findFileByLink，那边是验的：
    // 结果是同一个死链，列表能看、下载 404，两条入口自相矛盾。
    // （这个洞是实测撞出来的：继承态文件上生成链接后，列表照样列出该文件。）
    if (!file || !(await linkGrantsFile(db, link, file.id))) {
      throw createError({ statusCode: 404, message: notActive })
    }
    return {
      success: true,
      currentFolderId: null,
      isOwner: false,
      sharedList: false,
      canWrite: false,
      linkMode: true,
      folder: null,
      folders: [],
      files: tag([file])
    }
  }

  if (folderId === null) folderId = target.id

  if (!(await linkGrantsFolder(db, link, folderId))) {
    throw createError({ statusCode: 404, message: notActive })
  }

  const { folders, files } = await listChildrenByLink(folderService, fileService, target.ownerId, folderId)

  return {
    success: true,
    currentFolderId: folderId,
    isOwner: false,
    // 匿名视角没有「粘贴的目标」这回事，sharedList 让前端别给这类入口
    sharedList: false,
    canWrite: false,
    linkMode: true,
    folder: {
      id: folderId,
      name: (await folderService.findOwnedById(target.ownerId, folderId))?.name ?? ''
    },
    folders: tag(folders),
    files: tag(files)
  }
}

/**
 * 列表。三种情况，同一个接口：
 *
 *   folderId 为空 且 me == target  →  target 的根目录
 *   folderId 为空 且 me != target  →  「分享给我的」平铺清单，跨属主
 *   folderId 指定                  →  该目录内容；target 是属主则全给，
 *                                    否则按 resolveAccess 只给读得到的
 *
 * me != target 只有 adminMode（管理员 + useAdmin）才可能，所以第二个分支
 * 是管理员代看某人时的「入口」；普通用户看自己时 me 恒等于 target。
 *
 * 带 link 时走另一条完全独立的路（listByLink），**与登录态无关** ——
 * 理由同 download.post.ts：链接永远只能给出 LINK_PERMISSION。
 */
export default defineEventHandler(async (event) => {
  try {
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const q = getQuery(event) as { folderId?: string; link?: string }
    // 必须在 getMeAndTarget 之前判：它对未登录请求直接 401，
    // 而带链接的请求本来就该匿名通过（中间件已经放过来了）。
    const link = normalizeShareLink(q?.link)
    if (link) {
      // 匿名可调，所以身份用 optionalAuth 取：拿不到就走访客口径的提示。
      // 它只读 cookie、不碰 body，与这个接口的 body 处理互不干扰。
      const session = await optionalAuth(event)
      return await listByLink(db, link, q?.folderId, session ? Number(session.userId) : null)
    }

    const { me, targetUserId, adminMode, authUserId } = await getMeAndTarget(event)
    const rawFolderId = q?.folderId

    const fileService = new FileService(db)
    const folderService = new FolderService(db)

    /**
     * 附上前端要用的判定字段：
     *   ownerId     —— 分享设置只有属主能改，据此决定按钮是「管理分享」还是「看权限」
     *   canWrite    —— 据此把剪贴/重命名/删除按条目置灰
     *   perm        —— 我对这个条目的**完整**位掩码（含删除位），弹层里显示「你所有的权限」
     *   permSource  —— 这份权限的来源（直接授权 / 继承 / 公开），回答「我为什么能看到它」
     * 记录里本来就带 userId，这里只是给它一个语义明确的名字。
     *
     * ## 为什么顺带抹掉 fileKey
     *
     * fileKey 是 COS 里的**真实对象路径**（`users/141/202610/secret.xlsx`）。
     * 只读受权人（perm=READ，没有下载位）本来下载会被 403 挡掉，但他仍然能从
     * 列表响应里读到完整路径 —— 纵深防御上的缺口：路径一旦泄漏，攻击者就能
     * 直接拿它去构造请求，不必再猜。
     *
     * 抹掉它不影响任何功能：**预览和下载都走 /api/files/download，而那个接口
     * 要 PERM_DOWNLOAD**。没有下载位的人点预览本来就会被 403，fileKey 留给他
     * 纯属白给。有下载位的人（含属主、含分享链接的 LINK_PERMISSION）照常拿到。
     */
    const withMeta = <T extends { userId: number; canWrite?: boolean; perm?: number; permSource?: PermSource }>(
      rows: T[],
      fallback: { perm: number; permSource: PermSource }
    ) =>
      rows.map(r => {
        const perm = r.perm ?? fallback.perm
        const out = {
          ...r,
          ownerId: r.userId,
          perm,
          permSource: r.permSource ?? fallback.permSource,
          canWrite: r.canWrite ?? hasPermission(perm, PERM_WRITE)
        }
        // 没有下载位就不给对象路径。null 而不是删字段：前端的类型是可选的，
        // 显式 null 比 undefined 少一类「这个键到底存不存在」的分支。
        if (!hasPermission(perm, PERM_DOWNLOAD) && 'fileKey' in r) {
          ;(out as Record<string, unknown>).fileKey = null
        }
        return out
      })

    // 解析 folderId，root / 0 / 缺省都视为根层
    let folderId: number | null = null
    if (rawFolderId && rawFolderId !== 'root' && rawFolderId !== '0') {
      const parsed = Number(rawFolderId)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw createError({ statusCode: 400, message: '非法的 folderId' })
      }
      folderId = parsed
    }

    /**
     * 根层 + 不是管理视角 + 看的是别人 = 「分享给我的」平铺清单。
     *
     * adminMode 排除在外：管理视角下根层是该用户的**完整根目录**（原版行为，
     * /manage/files 依赖它），不能被这个分支劫持。
     */
    if (folderId === null && targetUserId !== me.userId && !adminMode) {
      const shared = await fileService.listSharedWithMe(me.userId, targetUserId)
      return {
        success: true,
        currentFolderId: null,
        isOwner: false,
        sharedList: true,
        ownerId: targetUserId,
        // 平铺清单没有「当前目录」概念，可写性逐条给（listSharedWithMe 已算好）
        canWrite: false,
        folders: withMeta(shared.folders, { perm: 0, permSource: 'none' }),
        files: withMeta(shared.files, { perm: 0, permSource: 'none' })
      }
    }

    // 属主或对该目录有读权限的被授权人都能浏览；其余一律 404。
    // 判定一律用 authUserId：useAdmin 时它是属主 → 退化成原版的纯归属判定；
    // 否则是我 → 走分享权限。
    const authId = Number(authUserId)
    const ownedFolder = folderId === null ? null : await folderService.findOwnedById(authId, folderId)
    const isOwner = folderId === null || !!ownedFolder

    // 当前目录我能不能写。共享视图的工具条（上传/新建/粘贴）靠它显隐。
    let dirCanWrite = true
    let subtreeOwnerId = authId
    // 目录解析的真结果，attachMasks 直接用它。原先手搓一个字面量传进去，
    // 会把 hasBoundary 丢掉，文件于是退回「自己 IsPublic=1 就生效」的老行为。
    let dirAccess: ResolvedAccess = {
      boundary: true,
      mode: SHARE_SHARED,
      isPublic: false,
      mask: PERM_ALL,
      source: 'owner',
      hasBoundary: true
    }
    if (!isOwner) {
      const access = await folderService.resolveAccess(authId, folderId)
      if (!hasPermission(access.mask, PERM_READ)) {
        throw createError({ statusCode: 404, message: '文件夹不存在或无权限' })
      }
      dirAccess = access
      dirCanWrite = hasPermission(access.mask, PERM_WRITE)
      subtreeOwnerId = (await folderService.getOwnerId(folderId!)) ?? authId
    }

    // 顺序执行而非 Promise.all：同一 sqlite3 handle 并发跑语句时本机原生绑定崩过
    const childFolders = await folderService.listChildren(subtreeOwnerId, folderId)
    const allFiles = await fileService.listFolderContents(folderId, subtreeOwnerId)

    /**
     * presetActive = 「继承态下自己设的名单/公开」当前生效吗？
     *
     * 继承是预设：设了但整条链没人拍板（含根目录自己）、或最近边界是「不分享」
     * 那道墙时，预设都不生效。属主这时看到的是「我设了却没人能进」，
     * 前端据此在图标右下角点一个红点。
     *
     * 逐条查是因为每个子项的最近边界各不相同（子目录可能自己就是边界）。
     * 与访问者身份无关，属主视角也查 —— 这正是属主最需要看到的场景。
     */
    const withPreset = async <T extends { id: number }>(rows: T[], check: (r: T) => Promise<boolean>) => {
      for (const r of rows) (r as any).presetActive = await check(r)
      return rows
    }
    await withPreset(childFolders, (f) => folderService.isPresetActive(f.id))
    await withPreset(allFiles, (f) => fileService.isPresetActiveForFile(f))

    // 被授权人只看得到自己读得到的：
    // 文件按目录已解析出的权限位过滤；子文件夹逐个 resolveAccess（各自的边界不同）
    let folders = childFolders
    let files = allFiles
    if (!isOwner) {
      const kept: SharedEntry<OwnedFolder>[] = []
      for (const f of childFolders) {
        const access = await folderService.resolveAccess(authId, f.id)
        if (hasPermission(access.mask, PERM_READ)) {
          kept.push({
            ...f,
            canWrite: hasPermission(access.mask, PERM_WRITE),
            perm: access.mask,
            permSource: access.source
          })
        }
      }
      folders = kept
      // filterAccessible 已经逐个用 resolveFileAccess 算对了完整掩码（文件自身
      // Shared=1 时只认自己的名单/公开，不继承目录），只是把结果丢了。
      // attachMasks 把掩码和来源挂回去，顺带完成过滤。
      files = (await fileService.attachMasks(authId, allFiles, dirAccess)).filter((f) => f.perm > 0)
    }

    return {
      success: true,
      currentFolderId: folderId,
      isOwner,
      // 当前目录是否可写：共享视图据此决定要不要给上传/新建/粘贴入口
      canWrite: dirCanWrite,
      sharedList: false,
      // 当前目录名：从别人的共享目录进去时面包屑需要它，
      // 否则 useFileBrowser 只能显示「全部文件」
      folder: folderId === null
        ? null
        : { id: folderId, name: (await folderService.findOwnedById(subtreeOwnerId, folderId))?.name ?? '' },
      // 被授权分支里 perm/permSource 已逐条算好，withMeta 的 fallback 不会生效；
      // 属主走的是另一条路（不调 resolveAccess），直接标 owner + 全权。
      folders: withMeta(folders, { perm: PERM_ALL, permSource: 'owner' }),
      files: withMeta(files, { perm: PERM_ALL, permSource: 'owner' })
    }
  } catch (error: any) {
    console.error('Get items error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '获取列表失败' })
  }
})
