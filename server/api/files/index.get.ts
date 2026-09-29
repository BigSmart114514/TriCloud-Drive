// server/api/files/index.get.ts
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { FileService, FolderService } from '~~/server/utils/db'
import { hasPermission, PERM_ALL, PERM_READ } from '~~/types/share'
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
     * 附上 ownerId：分享设置只有属主能改，前端要靠它决定给不给分享入口。
     * 记录里本来就带 userId，这里只是给它一个语义明确的名字。
     */
    const withOwner = <T extends { userId: number }>(rows: T[]) =>
      rows.map(r => ({ ...r, ownerId: r.userId }))

    // 解析 folderId，root / 0 / 缺省都视为根层
    let folderId: number | null = null
    if (rawFolderId && rawFolderId !== 'root' && rawFolderId !== '0') {
      const parsed = Number(rawFolderId)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw createError({ statusCode: 400, statusMessage: '非法的 folderId' })
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
        folders: withOwner(shared.folders),
        files: withOwner(shared.files)
      }
    }

    // 属主或对该目录有读权限的被授权人都能浏览；其余一律 404。
    // 判定一律用 authUserId：useAdmin 时它是属主 → 退化成原版的纯归属判定；
    // 否则是我 → 走分享权限。
    const authId = Number(authUserId)
    const ownedFolder = folderId === null ? null : await folderService.findOwnedById(authId, folderId)
    const isOwner = folderId === null || !!ownedFolder

    let dirAccessMask = PERM_ALL
    let subtreeOwnerId = authId
    if (!isOwner) {
      const access = await folderService.resolveAccess(authId, folderId)
      if (!hasPermission(access.mask, PERM_READ)) {
        throw createError({ statusCode: 404, statusMessage: '文件夹不存在或无权限' })
      }
      dirAccessMask = access.mask
      subtreeOwnerId = (await folderService.getOwnerId(folderId!)) ?? authId
    }

    // 顺序执行而非 Promise.all：同一 sqlite3 handle 并发跑语句时本机原生绑定崩过
    const childFolders = await folderService.listChildren(subtreeOwnerId, folderId)
    const allFiles = await fileService.listFolderContents(folderId, subtreeOwnerId)

    // 被授权人只看得到自己读得到的：
    // 文件按目录已解析出的权限位过滤；子文件夹逐个 resolveAccess（各自的边界不同）
    let folders = childFolders
    let files = allFiles
    if (!isOwner) {
      const kept: OwnedFolder[] = []
      for (const f of childFolders) {
        const access = await folderService.resolveAccess(authId, f.id)
        if (hasPermission(access.mask, PERM_READ)) kept.push(f)
      }
      folders = kept
      files = await fileService.filterAccessible(authId, allFiles, {
        boundary: true,
        isPublic: false,
        mask: dirAccessMask
      })
    }

    return {
      success: true,
      currentFolderId: folderId,
      isOwner,
      sharedList: false,
      // 当前目录名：从别人的共享目录进去时面包屑需要它，
      // 否则 useFileBrowser 只能显示「全部文件」
      folder: folderId === null
        ? null
        : { id: folderId, name: (await folderService.findOwnedById(subtreeOwnerId, folderId))?.name ?? '' },
      folders: withOwner(folders),
      files: withOwner(files)
    }
  } catch (error: any) {
    console.error('Get items error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '获取列表失败' })
  }
})
