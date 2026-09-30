// server/api/files/index.get.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { FileService, FolderService } from '~~/server/utils/db'
import type { PermSource, ResolvedAccess, SharedEntry } from '~~/server/utils/db'
import { hasPermission, PERM_ALL, PERM_READ, PERM_WRITE, SHARE_SHARED } from '~~/types/share'
import { getQuery } from 'h3'

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
 */
export default defineEventHandler(async (event) => {
  try {
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const { me, targetUserId, adminMode, authUserId } = await getMeAndTarget(event)
    const { folderId: rawFolderId } = getQuery(event) as { folderId?: string }

    const fileService = new FileService(db)
    const folderService = new FolderService(db)

    /**
     * 附上前端要用的判定字段：
     *   ownerId     —— 分享设置只有属主能改，据此决定按钮是「管理分享」还是「看权限」
     *   canWrite    —— 据此把剪贴/重命名/删除按条目置灰
     *   perm        —— 我对这个条目的**完整**位掩码（含删除位），弹层里显示「你所有的权限」
     *   permSource  —— 这份权限的来源（直接授权 / 继承 / 公开），回答「我为什么能看到它」
     * 记录里本来就带 userId，这里只是给它一个语义明确的名字。
     */
    const withMeta = <T extends { userId: number; canWrite?: boolean; perm?: number; permSource?: PermSource }>(
      rows: T[],
      fallback: { perm: number; permSource: PermSource }
    ) =>
      rows.map(r => {
        const perm = r.perm ?? fallback.perm
        return {
          ...r,
          ownerId: r.userId,
          perm,
          permSource: r.permSource ?? fallback.permSource,
          canWrite: r.canWrite ?? hasPermission(perm, PERM_WRITE)
        }
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
