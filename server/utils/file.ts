import { Database, FolderService } from '~~/server/utils/db'
import { DEFAULT_SHARE_MODE } from '~~/types/share'
import { FileRecord } from '~~/types/files'
import { GeneralResponse } from '~~/types/auth'
import { skipAndOverwriteError, ServerError } from '~~/types/error'
import { escapeLike, escapeRegExp } from '~~/server/utils/escape'
import { resolveUniqueName, FILE_NAMES } from '~~/server/utils/naming'

/**
 * 给同目录里的文件找一个不冲突的名字。
 *
 * 算法本体在 server/utils/naming.ts —— 它原先在 file.ts 与 folders.ts 里各抄了
 * 一份，而 save.post.ts 上还有第三份（buildName），三份已经开始分叉。
 * 这里只保留薄壳，因为调用点用的是「文件」这个说法。
 */
export async function resolveUniqueFilename(db: Database, userId: number, folderId: number | null, desired: string): Promise<{ name: string, base: string, ext: string, nextN: number }> {
    return resolveUniqueName(db, FILE_NAMES, userId, folderId, desired, true)
}


export async function save(db: Database, file: FileRecord, overwrite: boolean | null | undefined, skipIfExist: boolean | null | undefined): Promise<GeneralResponse> {
    overwrite = !!overwrite
    skipIfExist = !!skipIfExist
    if (overwrite && skipIfExist) {
        throw skipAndOverwriteError
    }
    const folderId = file.folderId
    // FileRecord.user_id 现在是可选的（前端拿到的行里没这个字段，见 types/files.ts
    // 的注释）。但走到 save() 的记录一定是从 DB 读出来的，属主必然存在 ——
    // 缺了就说明调用方传错了东西，直接抛错，别让它变成 undefined 流进 SQL。
    const userId = file.user_id
    if (userId == null) {
        throw createError({ statusCode: 500, message: '保存文件时缺少 user_id' })
    }
    // 将 0/undefined 视为根目录（NULL）
    const folderIdVal =
        Number.isFinite(folderId) && Number(folderId) > 0 ? Number(folderId) : null
    const filename = file.filename?.trim()

    // 目标目录归属校验，根层放行
    await new FolderService(db).assertOwned(userId, folderIdVal)

    if (!overwrite && !skipIfExist) {

        const newFilename = (await resolveUniqueFilename(db, userId, folderId, filename)).name

        const sql = `
            INSERT INTO files
            (user_id, folder_id, filename, file_key, file_size, file_url, content_type, created_at, Shared)
            VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `

        const params = [
            Number(userId),
            folderIdVal,
            newFilename,
            file.fileKey,
            Number(file.fileSize),
            file.fileUrl,
            file.contentType || null,
            file.createdAt,
            DEFAULT_SHARE_MODE,
        ]
        await db.prepare(sql).bind(...params).run()
        return { success: true }
    }
    else if (overwrite) {
        // Shared 只在首次插入时给默认值；命中已有行的分支不会改动它
        const sql = `
      INSERT INTO files (
      user_id, folder_id, filename, file_key, file_size, file_url, content_type, created_at, Shared
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, folder_id, filename)
      DO UPDATE SET
      file_key     = excluded.file_key,
      file_size    = excluded.file_size,
      file_url     = excluded.file_url,
      content_type = excluded.content_type,
      created_at   = excluded.created_at;
  `
        const params = [
            Number(userId),
            folderIdVal,
            filename,
            file.fileKey,
            Number(file.fileSize),
            file.fileUrl,
            file.contentType || null,
            file.createdAt,
            DEFAULT_SHARE_MODE,
        ]
        await db.prepare(sql).bind(...params).run() // 这里改为 run()
        return { success: true }
    } else if (skipIfExist) {
        const stmt = db.prepare(`
        INSERT OR IGNORE INTO files (
            user_id, folder_id, filename, file_key, file_size, file_url, content_type, created_at, Shared
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const params = [
            Number(userId),
            folderIdVal,
            filename,
            file.fileKey,
            Number(file.fileSize),
            file.fileUrl,
            file.contentType || null,
            file.createdAt,
            DEFAULT_SHARE_MODE,
        ]
        const result = await stmt.bind(...params).run()
        if (Number(result.meta.changes) === 1)  // 0 = 已存在, 1 = 新增
        {
            return { success: true }
        }
        else return { success: false }
    } else {
        throw ServerError
    }
}
// 归属校验请优先用 FileService（server/utils/db.ts）里的 assertOwnedById
export async function getFileById(db: Database, userId: number, fileId: number): Promise<FileRecord | null> {

    const row = await db
        .prepare(`
      SELECT
        id,
        folder_id    AS folderId,
        filename,
        file_key     AS fileKey,
        file_size    AS fileSize,
        file_url     AS fileUrl,
        content_type AS contentType,
        created_at   AS createdAt,
        user_id
      FROM files
      WHERE id = ? AND user_id = ?
    `)
        .bind(fileId, userId)
        .first()

    if (!row) return null

    // 兼容 MySQL 可能把 BIGINT 返回为字符串的情况
    const fileSize =
        typeof row.fileSize === 'string' ? Number(row.fileSize) : (row.fileSize ?? 0)

    const folderId =
        row.folderId === null || row.folderId === undefined ? null : Number(row.folderId)

    const record: FileRecord = {
        id: Number(row.id),
        folderId,
        filename: String(row.filename),
        fileKey: String(row.fileKey),
        fileSize,
        fileUrl: String(row.fileUrl),
        contentType: row.contentType ? String(row.contentType) : '',
        createdAt: String(row.createdAt),
        user_id: Number(row.user_id),
    }

    return record
}

export async function del(db: Database, userId: number, fileId: number): Promise<undefined> {
    await db.prepare(`
        DELETE FROM files WHERE id = ? AND user_id = ?;
    `).bind(fileId, userId).run()
}

export async function delEmptySubfolder(db: Database, userId: number, folderId: number) {
    if (folderId == null || Number.isNaN(Number(folderId))) return

    const CHUNK_SIZE = 500

    const rowsFromAll = (res: any) => Array.isArray(res?.results) ? res.results : []
    const affectedFromRun = (res: any) => {
        const meta = res?.meta ?? {}
        if (typeof meta.changes === 'number') return meta.changes       // SQLite / D1
        if (typeof meta.affectedRows === 'number') return meta.affectedRows // MySQL
        return 0
    }
    const placeholders = (n: number) => new Array(n).fill('?').join(',')

    // 1) 收集整个子树（包含 folderId 自身），每一跳都限定 user_id
    const subtree = new Set<number>()
    subtree.add(Number(folderId))
    let frontier: number[] = [Number(folderId)]

    while (frontier.length > 0) {
        const ph = placeholders(frontier.length)
        const sql = `SELECT id FROM folders WHERE user_id = ? AND parent_id IN (${ph})`
        const res = await db.prepare(sql).bind(userId, ...frontier).all()
        const rows = rowsFromAll(res)

        const next: number[] = []
        for (const r of rows) {
            const id = Number(r.id)
            if (!subtree.has(id)) {
                subtree.add(id)
                next.push(id)
            }
        }
        frontier = next
    }

    // 2) 反复删除叶子空文件夹，直到没有可删者
    while (true) {
        const ids = Array.from(subtree)
        if (ids.length === 0) break

        // 2.1 找出当前仍存在的“叶子空文件夹”
        const empties: number[] = []
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const batch = ids.slice(i, i + CHUNK_SIZE)
            if (batch.length === 0) continue

            const ph = placeholders(batch.length)
            const selSql = `
        SELECT f.id
        FROM folders f
        WHERE f.user_id = ?
          AND f.id IN (${ph})
          AND NOT EXISTS (SELECT 1 FROM files   WHERE folder_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM folders WHERE parent_id = f.id)
      `
            const selRes = await db.prepare(selSql).bind(userId, ...batch).all()
            const selRows = rowsFromAll(selRes)
            for (const r of selRows) {
                empties.push(Number(r.id))
            }
        }

        if (empties.length === 0) break

        // 2.2 删除这些空文件夹（分片删除，避免占位符过多）
        let deletedThisRound = 0
        for (let i = 0; i < empties.length; i += CHUNK_SIZE) {
            const batch = empties.slice(i, i + CHUNK_SIZE)
            const ph = placeholders(batch.length)
            const delSql = `DELETE FROM folders WHERE user_id = ? AND id IN (${ph})`
            const delRes = await db.prepare(delSql).bind(userId, ...batch).run()
            deletedThisRound += affectedFromRun(delRes)
        }

        // 从子树集合里去掉已删除的 id（减少下轮遍历规模）
        for (const id of empties) subtree.delete(id)

        // 理论上 deletedThisRound > 0，否则会提前 break
        if (deletedThisRound === 0) break
    }
}
