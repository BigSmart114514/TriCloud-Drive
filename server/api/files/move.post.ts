import { defineEventHandler, readBody } from 'h3'
import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService, FolderService } from '~~/server/utils/db'
import { ensurePaths } from '~~/server/utils/folders'
import { skipAndOverwriteError } from '~~/types/error'
import { uniqPositiveInts } from '~~/server/utils/functions'
import {
  resolveUniqueFilename,
  delEmptySubfolder,
} from '~~/server/utils/file'

export default defineEventHandler(async (event) => {
  const { targetUserId } = await getMeAndTarget(event)
  const userId = Number(targetUserId)
  const db = getDb(event)

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
    return { success: true, moved: { folders: 0, files: 0 }, skipped: 0, failed: 0, message: '无移动项' }
  }

  const fileService = new FileService(db)
  const folderService = new FolderService(db)

  // 校验目标文件夹
  if (targetFolderId !== null) {
    if (!(await folderService.findOwnedById(userId, targetFolderId))) {
      return { success: false, message: '目标文件夹不存在或无权限' }
    }
  }

  // 拉取待移动文件夹/文件（基本信息）
  const movedFolders = await folderService.findOwnedMany(userId, folderIds)

  if (movedFolders.length !== folderIds.length) {
    return { success: false, message: '部分文件夹不存在或无权限' }
  }

  const movedFiles = await fileService.findOwnedMany(userId, fileIds)

  if (movedFiles.length !== fileIds.length) {
    return { success: false, message: '部分文件不存在或无权限' }
  }

  // 工具：取父级 id（带 user_id，跨用户目录会直接取不到）
  const getParentId = (fid: number): Promise<number | null> => folderService.getParentId(userId, fid)

  // 防止把文件夹移动到其自身或其子孙中（重要：杜绝将自己移动到自己的子目录）
  const isTargetInsideFolder = async (folderId: number, targetId: number): Promise<boolean> => {
    let cur: number | null = targetId
    const visited = new Set<number>()
    for (let i = 0; i < 10000 && cur != null; i++) {
      if (visited.has(cur)) break
      if (cur === folderId) return true
      visited.add(cur)
      cur = await getParentId(cur)
    }
    return false
  }

  if (targetFolderId !== null) {
    for (const f of movedFolders) {
      if (f.id === targetFolderId) {
        return { success: false, message: `不能将文件夹 "${f.name}" 移动到其自身` }
      }
      const cyclic = await isTargetInsideFolder(f.id, targetFolderId)
      if (cyclic) {
        return { success: false, message: `不能将文件夹 "${f.name}" 移动到其子孙文件夹中` }
      }
    }
  }

  // 收集 folder 子树（目录路径与文件），并生成要在目标处创建的所有相对路径
  const CHUNK = 500
  const pathsToEnsure = new Set<string>() // e.g. "A", "A/B", "A/B/C"
  const relPathByFolderId = new Map<number, string>() // folderId -> "A/B"
  const filesFromFolders: { id: number, filename: string, folderId: number }[] = []
  const filesFromFoldersSet = new Set<number>()

  async function collectSubtree(rootId: number, rootName: string) {
    // 相对路径：root 从自己的名字开始
    relPathByFolderId.set(rootId, rootName)
    pathsToEnsure.add(rootName)

    const subtree = new Set<number>([rootId])
    let frontier: number[] = [rootId]
    while (frontier.length > 0) {
      const children = await folderService.listChildrenByParentIds(userId, frontier)
      const next: number[] = []
      for (const c of children) {
        if (!subtree.has(c.id)) {
          subtree.add(c.id)
          const parentPath = relPathByFolderId.get(c.parentId ?? -1) || ''
          const myPath = parentPath ? `${parentPath}/${c.name}` : c.name
          relPathByFolderId.set(c.id, myPath)
          pathsToEnsure.add(myPath)
          next.push(c.id)
        }
      }
      frontier = next
    }

    // 收集该子树中的所有文件
    const ids = Array.from(subtree)
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK)
      const list = await fileService.listByFolders(userId, batch)
      for (const f of list) {
        filesFromFolders.push({ id: f.id, filename: f.filename, folderId: f.folderId as number })
        filesFromFoldersSet.add(f.id)
      }
    }
  }

  for (const f of movedFolders) {
    await collectSubtree(Number(f.id), String(f.name))
  }

  // 在目标位置创建/复用所有需要的目录（含空目录）
  const destMap = await ensurePaths(db, userId, {
    parentId: targetFolderId,
    paths: Array.from(pathsToEnsure),
  })

  // 生成移动计划：来自“文件夹”的文件 + 额外指定的“单个文件”（排除已在子树内的）
  type MoveItem = { id: number, filename: string, srcFolderId: number | null, destFolderId: number | null }
  const plan: MoveItem[] = []

  // 来自文件夹子树的文件
  for (const f of filesFromFolders) {
    const rel = relPathByFolderId.get(f.folderId) || ''
    const destFolderId = rel ? (destMap[rel] ?? null) : targetFolderId // 理论上 rel 不会为空
    plan.push({
      id: f.id,
      filename: f.filename,
      srcFolderId: f.folderId ?? null,
      destFolderId,
    })
  }

  // 额外选中的单个文件
  for (const f of movedFiles) {
    if (filesFromFoldersSet.has(Number(f.id))) continue
    plan.push({
      id: Number(f.id),
      filename: String(f.filename),
      srcFolderId: (f.folderId === undefined || f.folderId === null) ? null : Number(f.folderId),
      destFolderId: targetFolderId,
    })
  }

  // 事务开始
  await db.prepare('SAVEPOINT move_tx').bind().run()
  let moved = 0, skipped = 0, failed = 0

  const findDup = (destFolderId: number | null, filename: string) =>
    fileService.findByName(userId, destFolderId, filename).then((row) => (row ? row.id : null))

  try {
    for (const item of plan) {
      const { id, filename, srcFolderId, destFolderId } = item

      // 移动到相同文件夹（同位置）=> 直接跳过，避免“自我覆盖/自杀”
      if ((srcFolderId ?? null) === (destFolderId ?? null)) {
        skipped++
        continue
      }

      // 查目的地是否存在同名文件
      const dupId = await findDup(destFolderId, filename)

      if (dupId !== null) {
        // 冲突存在
        if (body?.skipIfExist) {
          // 跳过
          skipped++
          continue
        } else if (body?.overwrite) {
          // 先删目的地重名，再移动源（UPDATE 源记录）
          if (dupId !== id) {
            await fileService.deleteOwned(userId, dupId)
          }
          await fileService.updateLocation(userId, id, destFolderId)
          moved++
        } else {
          // 默认：生成唯一名，直接在源记录上改名 + 改目录
          const { name: newName } = await resolveUniqueFilename(db, userId, destFolderId, filename)
          await fileService.updateLocation(userId, id, destFolderId, newName)
          moved++
        }
      } else {
        // 无冲突：直接 MOVE（UPDATE）
        await fileService.updateLocation(userId, id, destFolderId)
        moved++
      }
    }

    // 清理原空目录（仅对被选中的顶层目录做清理）
    for (const folderId of folderIds) {
      await delEmptySubfolder(db, userId, folderId)
    }

    await db.prepare('RELEASE move_tx').bind().run()

    // 移动完成后再重算存储
    await fileService.recalculateUsedStorage(userId)

    return {
      success: true,
      moved: { folders: folderIds.length, files: moved },
      skipped,
      failed,
      message: '移动完成',
    }
  } catch (e: any) {
    try {
      await db.prepare('ROLLBACK TO move_tx').bind().run()
      await db.prepare('RELEASE move_tx').bind().run()
    } catch { }
    return { success: false, moved: { folders: 0, files: 0 }, skipped, failed: plan.length - moved - skipped, message: e?.message || '移动失败' }
  }
})