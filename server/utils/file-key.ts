/**
 * 对象存储路径（file_key）的归属规则。
 *
 * ## 为什么需要它
 *
 * `files.file_key` 是 COS 里的**真实对象路径**，而它原先是客户端原样传进来的
 * （见 /api/files/save.post.ts）。服务端只在 /api/upload/credentials **生成**过
 * 这个路径，**从不复验**它 —— 于是任何人可以给自己的文件记录填上别人的命名
 * 空间（`users/141/...`），存进自己的行里。
 *
 * 单独看这还不构成越权：鉴权落在查到的那一行上，而那一行是自己的。但
 * /api/files/download 签 CDN 签名时用的是**请求里的** fileKey（不是那一行的），
 * 两处叠起来就成了「签出任意路径」。两个都修了：
 *   1. 插入前校验路径属于谁（这里）
 *   2. 签名改用 fileRecord.fileKey（download.post.ts）
 *
 * 只修 1 不够 —— 库里可能已经有重复行（历史数据、或别处写进去的）。
 * 只修 2 也只是把绕过面收窄，没有唯一约束时行为仍不确定。所以两边都要，
 * 再加上 files.file_key 的 UNIQUE 索引（db-migrate 建的）。
 *
 * ## 两种路径形状
 *
 * 仓库里有两处构造 key，形状不同，都得认：
 *   - 上传： `users/<id>/<YYYYMM>/<uuid><ext>`      （upload/credentials.post.ts）
 *   - 复制： `u/<id>/<YYYY-MM-DD>/<ts>_<rand>_<name>`（copy/paste.post.ts）
 *
 * 所以判定不能写死某一个前缀，而是「取前两段，第二段必须是属主 id」。
 */

/** 已知的命名空间前缀。写全是为了让新增前缀时被迫想一下这里。 */
export const FILE_KEY_PREFIXES = ['users', 'u'] as const

/**
 * 从 key 里解出属主 id；形状不认识就返回 null。
 *
 * 只解析前两段，不校验后面的文件名/扩展名 —— 那些是 COS 上真实存在的对象名，
 * 由生成方保证，插入时没有理由再猜一遍。
 */
export function fileKeyOwnerId(fileKey: unknown): number | null {
  if (typeof fileKey !== 'string') return null
  const parts = fileKey.split('/')
  // 至少 prefix/id/... 三段，否则不可能是本项目生成的路径
  if (parts.length < 3) return null
  // noUncheckedIndexedAccess 打开时，数组下标拿到的是 T | undefined。
  // 上面已经确保长度 >= 3，所以这里显式判一次而不是断言 —— 断言在运行时
  // 什么都不做，而这是道安全边界，宁可多写两行。
  const prefix = parts[0]
  const idRaw = parts[1]
  if (prefix === undefined || idRaw === undefined) return null
  if (!(FILE_KEY_PREFIXES as readonly string[]).includes(prefix)) return null
  // 必须是纯数字，避免 "5abc" 或 " 5" 这类被 parseInt 宽松吃掉
  if (!/^\d+$/.test(idRaw)) return null
  const id = Number(idRaw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * 这个 key 是不是属于 ownerId。
 *
 * 用在**写入路径**上（save / paste / 任何 INSERT INTO files ... file_key）。
 * 读路径不用这个 —— 读路径该按 id 查，见 download.post.ts。
 */
export function fileKeyBelongsTo(fileKey: unknown, ownerId: number): boolean {
  const id = fileKeyOwnerId(fileKey)
  return id !== null && id === ownerId
}

/** 错误对象：形状不认识 / 属主对不上，一律 400。 */
export function fileKeyMismatchError() {
  return createError({
    statusCode: 400,
    message: '文件路径与上传者不匹配，请重新上传'
  })
}

/**
 * 从 key 反推文件名。
 *
 * 两种 key 格式携带的信息量**不一样**，所以必须把「能不能还原」一并报出来：
 *
 *   u/<id>/<YYYY-MM-DD>/<ts>_<rand>_<名字>     名字还在 key 里 → 可还原
 *   users/<id>/<YYYYMM>/<uuid><ext>           只有 uuid。原名只存在于那一行
 *                                             files 的 filename 列，而那一行已经
 *                                             没了（正是「孤儿」的定义）
 *
 * 不报 recoverable 的话，界面上会给一个 32 位十六进制串配一个「下载」按钮，
 * 操作者会以为那就是文件名，点开发现不对再回头找 —— 而实际上那份信息已经
 * 永久消失了。直接说清楚比让他白找一趟好。
 *
 * 这里只做「尽力还原」，不做校验：还原出来的名字可能含斜杠或控制字符，
 * 所以调用方把它当**下载建议**用（Content-Disposition），不要拿它去拼路径。
 */
export function displayNameFromKey(fileKey: unknown): { name: string; recoverable: boolean } {
  if (typeof fileKey !== 'string' || !fileKey) return { name: '', recoverable: false }
  const last = fileKey.slice(fileKey.lastIndexOf('/') + 1)
  if (!last) return { name: '', recoverable: false }

  const prefix = fileKey.split('/')[0]

  // 复制路径的形状：<时间戳>_<随机>_<原名>
  if (prefix === 'u') {
    const m = last.match(/^\d+_[a-z0-9]+_(.+)$/i)
    if (m?.[1]) return { name: m[1], recoverable: true }
    return { name: last, recoverable: false }
  }

  // 上传路径：uuid + 扩展名。扩展名在，原名不在。
  return { name: last, recoverable: false }
}

/**
 * 写入前的守卫：不属于 ownerId 就抛。
 *
 * **ownerId 必须是解析出来的属主，不是发起请求的人。** upload/save 在
 * useAdmin 场景下是把文件写进别人的树（userId = dest.userId），拿 authId 去比
 * 会把管理员自己的合法上传也挡掉。
 */
export function assertFileKeyOwner(fileKey: unknown, ownerId: number) {
  if (!fileKeyBelongsTo(fileKey, ownerId)) throw fileKeyMismatchError()
}
