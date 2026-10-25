/**
 * 新建一个空白文件：桶里放一个 0 字节对象，库里插一行指向它。
 *
 * ## 为什么不是「前端拿 STS 凭证传一个空 Blob」
 *
 * 那条路要三次往返（凭证 → putObject → save），而且中间任何一步失败都会留下
 * 半截状态：凭证发了没传、传上去了没记库。空对象本身没有字节，服务端用主密钥
 * 直接 putObject 更短，也更容易保证「要么两边都有，要么两边都没有」。
 *
 * ## 顺序是承重的：先放对象，再写库
 *
 * 反过来的话，写库成功而 put 失败就得到一条**指向不存在对象的记录** ——
 * 列表里看得见、点下载 404，而且用户没法通过界面判断它是坏的。
 * 现在的顺序下，最坏情况是「桶里多一个没人认领的 0 字节对象」，那由对账
 * （manage/bucket 的孤儿清理）收得掉，不会让谁看到一个假文件。
 *
 * 所以写库失败时必须把刚放上去的对象删掉 —— 见下面 catch 里那句。
 *
 * ## 为什么不吃配额
 *
 * 空白文件是 0 字节，不可能把谁顶出容量。真正需要挡的是「这个账号还允许写吗」
 * （过期），那一步在端点里用 chainExpired 判，不在这里。
 *
 * ## 名字的重试
 *
 * `files` 上是 `UNIQUE(user_id, COALESCE(folder_id,-1), filename)`。两个请求
 * 同时建 `a.txt` 时都会查到「没人占用」，然后一个先插进去，另一个撞约束。
 * 这时要换 `a (2).txt` 再插，而不是把 409 丢给用户。
 *
 * key 里**没有原名**（`users/<id>/<YYYYMM>/<uuid><ext>`），改名字不会改 key，
 * 所以整个重试过程只放了一个对象 —— 别在循环里重新 put。
 */
import { createError } from 'h3'
import { buildUserFileKey } from '~~/server/utils/file-key'
import { dedupeName, resolveUniqueName, FILE_NAMES } from '~~/server/utils/naming'
import { DEFAULT_SHARE_MODE } from '~~/types/share'

/** 空白文件的类型。COS 与库里都记这个 —— 内容为空，没有更准的说法。 */
const BLANK_CONTENT_TYPE = 'application/octet-stream'

/** 与 save.post.ts 一致：撞名重试次数上限 */
const MAX_NAME_RETRY = 10

export interface CreateEmptyFileDeps {
  /** 在桶里放一个 0 字节对象。失败必须抛 —— 返回 false 会让调用方写出一行幽灵记录。 */
  putEmptyObject: (fileKey: string) => Promise<void>
  /** 尽力删掉一个对象（清理用，内部不该抛） */
  deleteObject: (fileKey: string) => Promise<unknown>
  /** 对象直链。形状与 useFileUpload 里算出来的一致。 */
  objectUrl: (fileKey: string) => string
}

export interface CreatedBlankFile {
  id: number
  folderId: number | null
  filename: string
  fileKey: string
  fileSize: number
  fileUrl: string
  contentType: string
  createdAt: string
}

/**
 * 校验用户输入的文件名。
 *
 * 前端也有一套（useNameEditing 的 validateName），但前端校验不是边界：
 * 这个端点可以直接被 POST。规则与前端保持同一口径（空 / 超长 / 含斜杠），
 * 另外挡掉 `.` 与 `..` —— 它们在任何文件系统里都不是文件。
 *
 * 斜杠必须挡死：它会进 `buildUserFileKey` 取扩展名的逻辑。那里已经先取
 * basename 再找点了（见 file-key.ts），但这道门是更早、更明确的一道。
 */
export function validateNewFileName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw createError({ statusCode: 400, message: '文件名不能为空' })
  if (name.length > 255) throw createError({ statusCode: 400, message: '文件名过长（最多255字符）' })
  if (name === '.' || name === '..') throw createError({ statusCode: 400, message: '非法的文件名' })
  if (/[\\/]/.test(name)) throw createError({ statusCode: 400, message: '文件名不可包含斜杠' })
  return name
}

/**
 * 这个冲突是不是「同一目录里重名」。
 *
 * `files` 上只有两条唯一索引：重名那条与 file_key 那条。file_key 是 uuid，
 * 撞了改名也没用（而且真撞上说明随机源坏了），所以判据写成
 * **UNIQUE 且不是 file_key**，而不是去匹配某条索引的名字 —— 索引改名不该
 * 让这里静默退化成「一律当重名，疯狂改名重试」。
 */
function isFilenameConflict(err: any): boolean {
  const msg = String(err?.message ?? '')
  return msg.includes('UNIQUE') && !msg.includes('file_key')
}

function toRecord(row: any): CreatedBlankFile {
  return {
    id: Number(row.id),
    folderId: row.folderId === null || row.folderId === undefined ? null : Number(row.folderId),
    filename: String(row.filename),
    fileKey: String(row.fileKey),
    fileSize: Number(row.fileSize ?? 0),
    fileUrl: String(row.fileUrl ?? ''),
    contentType: String(row.contentType ?? BLANK_CONTENT_TYPE),
    createdAt: String(row.createdAt ?? '')
  }
}

/**
 * @param ownerId 目标目录的**属主**（不是发起请求的人）。跨用户写时两者不同，
 *                传错就是「把对象放进别人的命名空间」。
 * @param folderId 已鉴权过的目标目录；null = 属主根层。
 * @param desiredName 用户输入的名字（会先过 validateNewFileName）
 */
export async function createEmptyFile(
  db: any,
  ownerId: number,
  folderId: number | null,
  desiredName: string,
  deps: CreateEmptyFileDeps
): Promise<CreatedBlankFile> {
  const wanted = validateNewFileName(desiredName)

  const { name: firstName, base, ext, nextN: firstN } =
    await resolveUniqueName(db, FILE_NAMES, ownerId, folderId, wanted, true)

  // 只放一次。名字后面会变，key 不会（key 里只有 uuid 与扩展名）。
  const fileKey = buildUserFileKey(ownerId, firstName)
  await deps.putEmptyObject(fileKey)

  try {
    let filename = firstName
    let n = firstN

    for (let attempt = 0; attempt < MAX_NAME_RETRY; attempt++) {
      try {
        const row = await db
          .prepare(`
            INSERT INTO files (user_id, folder_id, filename, file_key, file_size, file_url, content_type, Shared)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id, folder_id AS folderId, filename, file_key AS fileKey,
                      file_size AS fileSize, file_url AS fileUrl, content_type AS contentType,
                      created_at AS createdAt
          `)
          .bind(
            ownerId,
            folderId,
            filename,
            fileKey,
            0,
            deps.objectUrl(fileKey),
            BLANK_CONTENT_TYPE,
            DEFAULT_SHARE_MODE
          )
          .first()

        if (!row) throw createError({ statusCode: 500, message: '新建文件失败：数据库没有返回记录' })
        return toRecord(row)
      } catch (e) {
        if (!isFilenameConflict(e)) throw e
        // 并发撞名：换下一个候选名，不重新放对象。
        n += 1
        filename = dedupeName(base, ext, n)
      }
    }

    throw createError({ statusCode: 500, message: '新建文件失败：重名重试次数过多' })
  } catch (e) {
    // 库这侧没成，桶里那个对象就没人认领了。清掉，别留孤儿。
    // 清理失败不能盖掉真正的原因 —— 用户要看到的是「为什么没建成」。
    try {
      await deps.deleteObject(fileKey)
    } catch { /* 尽力而为 */ }
    throw e
  }
}
