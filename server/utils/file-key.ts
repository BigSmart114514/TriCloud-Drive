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
 * ## 路径形状：**一种**，加一种等着清理的历史形状
 *
 * 2026-10-08 统一。之前有两处构造 key、形状不同：
 *   - 上传： `users/<id>/<YYYYMM>/<uuid><ext>`         （upload/credentials.post.ts）
 *   - 复制： `u/<id>/<YYYY-MM-DD>/<ts>_<rand>_<原名>`   （copy/paste.post.ts）
 *
 * 复制那一套已经退役，两个原因：
 *   1. 分区粒度不同（YYYY-MM-DD vs YYYYMM），同一个用户的对象散在两种目录形状里
 *   2. **原名进了 key**。那意味着 key 形状依赖客户端给的文件名，于是多出一整个
 *      净化面（`sanitizeForKey` 就是为它写的，而且它已经漏过一次 `#`）。
 *      原名的家在 `files.filename` 那一列，key 里带一份只会多一个能坏的地方。
 *
 * 现在上传与复制共用 `buildUserFileKey`，形状一律 `users/<id>/<YYYYMM>/<uuid><ext>`。
 *
 * ## 属主判定不能写死某一个前缀
 *
 * 取前两段，第二段必须是属主 id。**两个前缀都要认**，哪怕新的 key 只写一个 ——
 * 因为 `u/` 的对象还在桶里（迁移没跑，见下面 FILE_KEY_PREFIXES 的说明）。
 */

/**
 * 新 key 只写这一个前缀。
 *
 * 单独拎出来而不是直接用 FILE_KEY_PREFIXES[0]：那个列表还包含等着清理的
 * 历史前缀，「写新的」和「认旧的」是两件事，合成一个索引就会在某天有人
 * 顺手把历史前缀也拿去写。
 */
export const ACTIVE_KEY_PREFIX = 'users'

/**
 * 必须**认得**的前缀。**新 key 不写 `u/`，但这里不能把它删掉。**
 *
 * 删掉的后果不是「老 key 报错」，而是更坏的东西：`u/` 的对象还在桶里，
 * 而对账靠遍历这个列表去列举。少一个前缀 = 那批对象在对账结果里彻底消失 ——
 * 既不会被报成孤儿（于是永远清不掉，存储一直计费），也不会被报成任何异常。
 * 界面上看不出任何问题，只是账单一直涨。
 *
 * 真正能删它的时点是 COS 迁移跑完、且**验证过桶里没有 `u/` 残留**之后。
 * 那一刻之前动它，就是主动制造一笔看不见的账。
 */
export const FILE_KEY_PREFIXES = ['users', 'u'] as const

/**
 * 从文件名里取出扩展名，形如 `.pdf`；没有可用扩展名时返回空串。
 *
 * ## 为什么不能直接 `substring(lastIndexOf('.'))`
 *
 * 那个写法在两个输入上给出的是「带路径的扩展名」：
 *   `a.b/c`   → `.b/c`   → key 变成 `users/1/202610/<uuid>.b/c`
 *   `.bashrc` → `.bashrc`→ key 变成 `users/1/202610/<uuid>.bashrc`（这个还无害）
 *
 * COS 的 key 是扁平字符串，`/` 只是普通字符，所以前者不会造成目录穿越 ——
 * 但它会让 key 里出现项目自己从不生成的形状，而 `fileKeyOwnerId` 只看前两段，
 * 于是这种畸形 key 能通过属主校验落进库。对账、列举、签名全都要额外考虑它。
 *
 * 上传侧原来就有这个写法（upload/credentials.post.ts），只是那个端点会先
 * 校验 filename 所以够不到；统一之后两条写入路径都走这里，必须自己站得住。
 *
 * 保留的字符只有 `[A-Za-z0-9]`，小写，长度封顶 —— 扩展名只是 key 的组织信息，
 * 显示用的名字来自 `files.filename`，所以这里收紧不影响用户看到的文件名。
 *
 * ## 先取 basename，再找点
 *
 * `../../etc/passwd` 这种输入：最后一个点在 `..` 后面，直接 slice 会拿到
 * `./etc/passwd`，洗掉非字母数字后变成 `etcpasswd` —— 于是原名的一截
 * （`etcpasswd`）被当成了扩展名塞进 key。不算安全问题（不是原始的 `passwd`，
 * 而且在 uuid 后面），但它违背「原名不进 key」这条，而且很难被注意到。
 *
 * 文件名本来不该含 `/`；真含了，就把最后一个 `/` 之后那段当名字 ——
 * 与文件系统的读法一致，也顺带让上面那个输入变成「无扩展名」。
 */
export function extensionFromFilename(filename: unknown): string {
  if (typeof filename !== 'string') return ''
  const base = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // 没有点，或者点在最后（`x.`）或开头（`.bashrc`）→ 没有可用扩展名
  if (dot <= 0 || dot === base.length - 1) return ''
  const cleaned = base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '')
  if (!cleaned) return ''
  return '.' + cleaned.toLowerCase().slice(0, 16)
}

/**
 * 构造对象存储的 key。**全项目只有这一个函数构造 key。**
 *
 *   users/<userId>/<YYYYMM>/<uuid><ext>
 *
 * 三个参数里只有前两个该由调用方给：
 *   userId    必须是**目标目录的属主**，不是发起请求的人。跨用户粘贴时
 *             两者不同（paste.post.ts 里 `const userId = destOwnerId`），
 *             传错就是「把副本写进别人的树」，而属主校验会认为它合法。
 *   filename  只用来取扩展名，**原名不进 key**。
 *   now       默认取当前时间；测试与迁移脚本要固定时间时显式传入。
 *
 * 分区用 UTC：服务器时区不是 UTC 时，月末/年末边界会把同一批文件分到相邻
 * 两个月桶里（本地 1/1 凌晨 = UTC 前一天）。
 */
export function buildUserFileKey(userId: number, filename: string, now: Date = new Date()): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${ACTIVE_KEY_PREFIX}/${userId}/${year}${month}/${crypto.randomUUID()}${extensionFromFilename(filename)}`
}

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
 * ## 新 key 一律不可还原（这是设计，不是缺陷）
 *
 * `buildUserFileKey` 产出的形状是 `users/<id>/<YYYYMM>/<uuid><ext>`，
 * **原名从来不进 key** —— 它只在 `files.filename` 那一列。所以对今天的对象
 * 这个函数永远返回 `recoverable: false`，而这是实话。
 *
 * 复制功能历史上把原名写进了 key（`u/<id>/…_<原名>`），于是机械上「能还原」。
 * 但那从来不是一个功能，只是一个副作用：产品上没有任何地方承诺过它，
 * 而它是靠「key 形状依赖客户端文件名」换来的 —— 多一整个净化面，
 * 而且已经漏过一次（`#`）。2026-10-08 统一形状时它就跟着没了。
 *
 * ## 那个 `u` 分支为什么还在
 *
 * 迁移没跑，`u/` 的对象还在桶里。对这些对象说「不可还原」是**撒谎** ——
 * 名字确实还在 key 里，操作者按提示去别处找会白跑一趟。所以分支保留，
 * 它现在的唯一职责是：如实描述存量，不为新对象发声。
 *
 * COS 迁移跑完并验证过没有 `u/` 残留之后，这个分支可以删；那时
 * `FILE_KEY_PREFIXES` 里的 `'u'` 也可以一起删（但删它的前提见那个常量的说明）。
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

  // 历史形状（复制功能，2026-10-08 退役）：<时间戳>_<随机>_<原名>。
  // 只为描述存量而存在 —— 新对象走不到这里。
  if (prefix === 'u') {
    const m = last.match(/^\d+_[a-z0-9]+_(.+)$/i)
    if (m?.[1]) return { name: m[1], recoverable: true }
    return { name: last, recoverable: false }
  }

  // 现行形状：uuid + 扩展名。扩展名在，原名不在。
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
