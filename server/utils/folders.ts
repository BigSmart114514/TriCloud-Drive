// server/utils/folders.ts
import { createError } from 'h3'
import { Database, FolderService } from '~~/server/utils/db'
import { DEFAULT_SHARE_MODE } from '~~/types/share'
/*
type DBLike = {
  prepare: (sql: string) => {
    bind: (...args: any[]) => any
    first: <T = any>() => Promise<T | null>
    run: () => Promise<any>
  }
}
*/
export function normalizeFolderId(input: any): number | null {
  if (input === undefined || input === null || input === '' || input === 'root' || input === '0' || input === 0) {
    return null
  }
  const n = Number(input)
  if (!Number.isInteger(n) || n < 1) {
    throw createError({ statusCode: 400, message: '非法的 parentId' })
  }
  return n
}

export function normalizePath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
}

function validateSegment(seg: string) {
  const name = seg.trim()
  if (!name) throw createError({ statusCode: 400, message: '目录名不能为空' })
  if (name.length > 255) throw createError({ statusCode: 400, message: `目录名过长：${name}` })
  if (name === '.' || name === '..') throw createError({ statusCode: 400, message: `非法目录名：${name}` })
  return name
}

function getLastInsertId(meta?: any): number | undefined {
  return meta?.lastID ?? meta?.insertId ?? meta?.last_row_id
}

// 父级归属校验统一走 FolderService，这里只做「根层放行」的短路
async function assertParent(db: Database, userId: number, parentId: number | null) {
  if (parentId === null) return
  const folderService = new FolderService(db)
  if (!(await folderService.findOwnedById(userId, parentId))) {
    throw createError({ statusCode: 404, message: '父级文件夹不存在或无权限' })
  }
}

/**
 * 创建单个文件夹（同一父级下不允许重名）
 * 保持与原 create.post.ts 相同的校验与返回
 */
export async function createFolder(
  db: Database,
  userId: number,
  params: { name?: any; parentId?: any }
) {
  const nameRaw = normalizeFolderName(String(params?.name || '').trim())
  const parentId = normalizeFolderId(params?.parentId)

  if (!nameRaw) {
    throw createError({ statusCode: 400, message: '文件夹名称不能为空' })
  }
  if (nameRaw.length > 255) {
    throw createError({ statusCode: 400, message: '文件夹名称过长（最多255字符）' })
  }

  await assertParent(db, userId, parentId)

  // 自动生成唯一名称 + 抢占式重试（并发友好）
  let folder: any
  for (let attempt = 0; attempt < 6; attempt++) {
    const { name: uniqueName } = await resolveUniqueFolderName(db, userId, parentId, nameRaw)
    try {
      const ins: any = await db
        .prepare('INSERT INTO folders (user_id, parent_id, name, Shared) VALUES (?, ?, ?, ?)')
        .bind(userId, parentId, uniqueName, DEFAULT_SHARE_MODE)
        .run()

      const newId = getLastInsertId(ins?.meta)
      if (newId) {
        folder = await db
          .prepare('SELECT id, name, parent_id AS parentId, created_at AS createdAt FROM folders WHERE id = ? AND user_id = ?')
          .bind(newId, userId)
          .first()
      } else {
        // 兜底查询（兼容不同驱动 meta 差异）
        const whereParent = parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'
        const stmt = db.prepare(`
          SELECT id, name, parent_id AS parentId, created_at AS createdAt
          FROM folders
          WHERE user_id = ? AND name = ? AND ${whereParent}
          ORDER BY id DESC
          LIMIT 1
        `)
        const args = parentId === null ? [userId, uniqueName] : [userId, uniqueName, parentId]
        folder = await stmt.bind(...args).first()
      }

      return folder
    } catch (e: any) {
      if (isUniqueConstraintError(e)) {
        // 与其他并发请求撞名了，稍等片刻后重试
        await new Promise((r) => setTimeout(r, 2))
        continue
      }
      throw e
    }
  }

  throw createError({ statusCode: 409, message: '在并发情况下无法生成唯一文件夹名，请稍后重试' })
}

/**
 * 批量按相对路径确保目录存在，并返回路径到最终目录ID的映射
 * 与原 ensure-paths.post.ts 保持行为一致（包含 SAVEPOINT 事务）
 */
export async function ensurePaths(
  db: Database,
  userId: number,
  params: { parentId?: any; paths?: any }
): Promise<Record<string, number>> {
  const parentId = normalizeFolderId(params?.parentId)
  let paths: string[] = Array.isArray(params?.paths) ? params.paths : []

  // 先校验父级归属，再看有没有路径要建，避免空 paths 绕过校验
  await assertParent(db, userId, parentId)

  if (!paths.length) return {}

  const uniq = Array.from(new Set(paths.map(normalizePath)))
  const result: Record<string, number> = {}

  await db.prepare('SAVEPOINT ensure_paths_tx').bind().run()
  try {
    for (const p of uniq) {
      if (!p) {
        if (parentId !== null) result[''] = parentId
        continue
      }
      const segs = p.split('/').map(validateSegment)
      let currentParent: number | null = parentId

      for (const seg of segs) {
        let row: any
        if (currentParent === null) {
          row = await db
            .prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? LIMIT 1')
            .bind(userId, seg)
            .first()
        } else {
          row = await db
            .prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND name = ? LIMIT 1')
            .bind(userId, currentParent, seg)
            .first()
        }

        if (!row) {
          const ins: any = await db
            .prepare('INSERT INTO folders (user_id, parent_id, name, Shared) VALUES (?, ?, ?, ?)')
            .bind(userId, currentParent, seg, DEFAULT_SHARE_MODE)
            .run()

          const newId = getLastInsertId(ins?.meta)
          if (newId) {
            currentParent = Number(newId)
          } else {
            // 兜底查询
            const back = currentParent === null
              ? await db
                .prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? ORDER BY id DESC LIMIT 1')
                .bind(userId, seg)
                .first()
              : await db
                .prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND name = ? ORDER BY id DESC LIMIT 1')
                .bind(userId, currentParent, seg)
                .first()
            currentParent = Number(back?.id)
          }
        } else {
          currentParent = Number(row.id)
        }
      }
      result[p] = currentParent as number
    }

    await db.prepare('RELEASE ensure_paths_tx').bind().run()
  } catch (e) {
    try {
      await db.prepare('ROLLBACK TO ensure_paths_tx').bind().run()
      await db.prepare('RELEASE ensure_paths_tx').bind().run()
    } catch { }
    throw e
  }

  return result
}

export async function resolveUniqueFolderName(
  db: Database,
  userId: number,
  parentId: number | null,
  desired: string
): Promise<{ name: string; base: string; nextN: number }> {
  const base = desired
  const likePattern = `${escapeLike(base)} (%)`

  let rows: any
  if (parentId === null) {
    rows = await db
      .prepare(`
        SELECT name FROM folders
        WHERE user_id = ?
          AND parent_id IS NULL
          AND (name = ? OR name LIKE ? ESCAPE '\\')
      `)
      .bind(userId, desired, likePattern)
      .all()
  } else {
    rows = await db
      .prepare(`
        SELECT name FROM folders
        WHERE user_id = ?
          AND parent_id = ?
          AND (name = ? OR name LIKE ? ESCAPE '\\')
      `)
      .bind(userId, parentId, desired, likePattern)
      .all()
  }

  const existing = new Set<string>((rows?.results || []).map((r: any) => String(r.name)))
  if (!existing.has(desired)) {
    return { name: desired, base, nextN: 1 }
  }

  // 与文件一致：如果只存在原名，没有任何 (n)，则生成 (2)
  const re = new RegExp(`^${escapeRegExp(base)} \\((\\d+)\\)$`)
  let maxN = 1
  for (const name of existing) {
    const m = name.match(re)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > maxN) maxN = n
    }
  }
  const nextN = maxN + 1
  return { name: `${base} (${nextN})`, base, nextN }
}

function isUniqueConstraintError(err: any) {
  const msg = String(err?.message || '')
  return (
    msg.includes('UNIQUE') ||
    msg.includes('unique') ||
    msg.includes('constraint') ||
    msg.includes('ux_folders_user_parent_name')
  )
}

/**
 * 处理文件夹名称，替换禁止字符和保留名称
 * param rawFolderName 原始文件夹名称
 * returns 处理后的安全文件夹名称
 */
export function normalizeFolderName(rawFolderName: string): string {
  if (!rawFolderName || rawFolderName.trim().length === 0) {
    return '新建文件夹';
  }

  // 字符替换映射表
  const charReplacements: { [key: string]: string } = {
    '<': '＜',
    '>': '＞',
    ':': 'ː',
    '"': '＂',
    '/': '⁄',
    '\\': '＼',
    '|': '∣',
    '?': '？',
    '*': '＊'
  };

  // 系统保留字映射表（只处理开头的字符）
  const reservedWordReplacements: { [key: string]: string } = {
    'C': 'Ⅽ',
    'P': 'Ｐ',
    'A': 'Ａ',
    'N': 'Ｎ',
    'L': 'Ｌ'
  };

  // 系统保留名称列表（不区分大小写）
  const reservedNames = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ];

  let result = rawFolderName;

  // 步骤1: 替换所有禁止字符
  for (const [forbiddenChar, replacement] of Object.entries(charReplacements)) {
    result = result.split(forbiddenChar).join(replacement);
  }

  // 步骤2: 检查并处理系统保留名称
  const upperCaseResult = result.toUpperCase();
  if (reservedNames.includes(upperCaseResult)) {
    // 替换第一个字符
    const firstChar = result.charAt(0).toUpperCase();
    if (reservedWordReplacements[firstChar]) {
      result = reservedWordReplacements[firstChar] + result.slice(1);
    }
  }

  // 步骤3: 处理结尾的空格和点
  if (result.length > 0) {
    const lastChar = result.charAt(result.length - 1);
    
    if (lastChar === ' ') {
      // 结尾空格替换为下划线
      result = result.slice(0, -1) + '_';
    } else if (lastChar === '.') {
      // 结尾点替换为中点
      result = result.slice(0, -1) + '・';
    }
  }

  // 如果处理后变成空字符串，返回默认名称
  if (result.trim().length === 0) {
    return '新建文件夹';
  }

  return result;
}