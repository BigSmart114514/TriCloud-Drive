// 共享模式（三态）。授权名单与边界标记是**两件独立的事**：
// 授权行写在 file_access / folder_access 里，谁被授权由名单决定；
// 「要不要在此切断向上继承」才由本字段决定。二者解耦后，
// 给某个节点单独加一个人就不会再意外切断上层已共享的其他人。
export const SHARE_NONE = 0        // 不分享：拒绝型边界，除属主外谁都拿不到
export const SHARE_SHARED = 1      // 分享：名单内放行（含 IsPublic 给所有已登录用户的 READ），名单外到此为止
export const SHARE_INHERIT = 2     // 继承：不是边界，继续向上查找；本节点名单仍然叠加生效

export type ShareMode = typeof SHARE_NONE | typeof SHARE_SHARED | typeof SHARE_INHERIT

/** 新建节点默认继承：在共享文件夹里新建的东西，团队立即可见 */
export const DEFAULT_SHARE_MODE: ShareMode = SHARE_INHERIT

/**
 * 节点自身的分享标记，UI 据此在图标上加角标。
 *
 * 只回答「属主对这个节点做过什么设置」，不回答「谁能访问」——
 * 后者是 resolveAccess / combineWithAncestor 的事，两回事，别混。
 */
export type ShareBadge = 'lock' | 'users' | 'share'

export interface ShareBadgeInput {
  /** 三态。缺失时按「没设置过」处理，不亮角标 */
  Shared?: number | null
  IsPublic?: boolean | null
  /** 我授权了多少人。只在继承态下参与判定：非空说明属主显式分享过 */
  grantCount?: number | null
}

/**
 * 算文件夹该亮什么角标。规则（与 SHARE_MODE_LABELS 同一套语义）：
 *
 *   不分享       → lock    阻止优先，IsPublic/名单都不看
 *   分享 + 公开  → users   非继承下公开优先
 *   分享 + 未公开 → share  非继承、无公开，那就是按名单
 *   继承 + 公开  → users
 *   继承 + 有人  → share   名单非空 = 属主分享过
 *   继承 + 没人  → 无角标  继承是默认值，没设置过就不提示
 *
 * 继承态为什么要看名单：继承本身「不表态」，默认不给任何人读（mask=0，
 * 见 combineWithAncestor）。所以「继承了但授权了人」是值得提示的设置，
 * 而「继承了但什么都没配」不是。
 *
 * `Shared` 走 normalizeShareMode 归一：字段缺失、null、''、脏值一律当「继承」，
 * 也就是「没设置过」→ 不亮角标。直接比 `!== SHARE_INHERIT` 会把这些全判成
 * 非继承（undefined !== 2 成立），于是没带该字段的条目全都亮起角标。
 */
export function resolveShareBadge(input: ShareBadgeInput): ShareBadge | null {
  // 走 normalizeShareMode 而不是 Number(input.Shared)：后者对 null/'' 都得到 0，
  // 而 0 正是 SHARE_NONE，字段缺失会被误判成「不分享」亮出锁图标。
  // normalizeShareMode 把 null/undefined/''/非 0-1-2 的一律当继承（fail-closed）。
  const mode = normalizeShareMode(input.Shared)

  if (mode === SHARE_NONE) return 'lock'
  if (input.IsPublic === true) return 'users'
  if (mode === SHARE_SHARED) return 'share'
  // 继承（含字段缺失）：只有名单非空才算「共享中」
  return Number(input.grantCount ?? 0) > 0 ? 'share' : null
}

/** 角标的悬浮说明。与 resolveShareBadge 的判定同源，避免文案和实际逻辑脱节 */
export const SHARE_BADGE_LABELS: Record<ShareBadge, string> = {
  lock: '不分享（已阻止继承）',
  users: '公开（所有登录用户可读）',
  share: '已分享（按授权名单）'
}

/**
 * 图标右下角那个红点 —— 提示「你设的分享当前没生效」。为什么会亮有两种原因，
 * 所以判定给的是 `reason` 而不是布尔：文案不一样（「名单没生效」和「链接是死的」
 * 要分开说，混成一句会让人去改错地方）。
 *
 * **原因一：链接是死的**（linkCount > 0 且自己不是「分享」态）
 *   见 linkActiveFromShareMode 的推导。不需要查库。
 *
 * **原因二：预设没生效**（原来那套），三个条件同时成立：
 *   1. 继承态（只有继承态才存在「预设」这回事）
 *   2. 确实设过东西（授权名单非空，或开了公开）—— 什么都没设就没有「没生效」
 *   3. 预设没生效（`presetActive === false`）：整条链没人拍板，含根目录自己；
 *      或者最近的那道边界是「不分享」，把它挡住了
 *
 * `presetActive` 缺失（undefined）时**不点**（原因二）：那说明这条数据没经过判定
 * （部分接口不返回它），宁可漏提示也不要给一份正常的分享挂个「没生效」。
 * 原因一不受此限 —— 死链判定只依赖列表本来就有的三态字段。
 */
/** 红点为什么亮。null = 不亮 */
export type ShareDotReason = 'link' | 'preset'

export function shareDotReason(input: {
  Shared?: number | null
  IsPublic?: boolean | null
  grantCount?: number | null
  /** 该节点上挂了几条分享链接。见下面 linkActiveFromShareMode 的推导 */
  linkCount?: number | null
  presetActive?: boolean | null
}): ShareDotReason | null {
  const mode = normalizeShareMode(input.Shared)

  /**
   * 死链优先判，且**不受「只在继承态判定」这条限制**。
   *
   * 判定就一句：这个节点不是「分享」，它身上的链接就永远不生效
   * （见 linkActiveFromShareMode）。不需要查库，也不需要 presetActive。
   *
   * 之所以连「不分享」也算：那种节点图标上已经有锁角标，但锁只说「这里不给看」，
   * 没说「你发的链接打不开」。两件事，都值得提示。
   */
  if (Number(input.linkCount ?? 0) > 0 && mode !== SHARE_SHARED) return 'link'

  if (mode !== SHARE_INHERIT) return null
  const hasSetting = input.IsPublic === true || Number(input.grantCount ?? 0) > 0
  if (!hasSetting) return null
  return input.presetActive === false ? 'preset' : null
}

export function shouldShowPresetDot(input: Parameters<typeof shareDotReason>[0]): boolean {
  return shareDotReason(input) !== null
}

/** 红点的悬浮说明。与 shareDotReason 同源，两种原因给不同文案 */
export function shareDotTitle(reason: ShareDotReason): string {
  return reason === 'link' ? LINK_DOT_TITLE : PRESET_DOT_TITLE
}

/**
   * 挂在某个节点上的链接当前生效吗？
   *
   * **不需要查库**：判定只看节点自己的三态（服务端 BOUNDARY_CTE 的推导）：
   *   Shared = 分享(1) → 边界落在自己、且不是墙 → 挂上来的链接全部生效
   *   Shared = 继承(2) → 自己不是边界，判定会往上找第一个非继承祖先，
   *                     那个祖先身上**没有**这条链接（链接挂在自己这儿）
   *                     → 拒绝。上游改成「分享」也救不回来
   *   Shared = 不分享(0) → 自己就是墙 → 拒绝
   * 所以「链接在不在这一层生效」等价于「自己是不是分享态」，而这本来就在
   * 列表数据里。省掉的是每条目一次上行 CTE —— 列表页是逐条查的，这笔开销不小。
   *
   * 与 `presetActive` 是两回事：那个问「名单/公开生效吗」，这个问「链接生效吗」。
   * 一个节点可以「链接有效但名单没生效」（在别人的分享目录里自己开了名单），
   * 反过来「名单生效但链接死的」就是死链这一种。
   */
export function linkActiveFromShareMode(shared: number | null | undefined): boolean {
  return normalizeShareMode(shared) === SHARE_SHARED
}

export const PRESET_DOT_TITLE = '你设置的分享当前没生效：上级目录里没有「分享」，或被「不分享」挡住了'

/**
 * 死链的红点提示。与 linkActiveFromShareMode 的判定同源。
 *
 * 只对**属主**显示（FileList 用 showShareBadge 门控），所以这里可以直说
 * 「怎么改能生效」—— 他就是要去改的人。
 */
export const LINK_DOT_TITLE =
  '这个分享链接现在打不开：需要把这个文件夹或它的上级目录设为「分享」'

export const SHARE_MODE_LABELS: Record<number, string> = {
  [SHARE_NONE]: '不分享',
  [SHARE_SHARED]: '分享',
  [SHARE_INHERIT]: '继承'
}

/** 只有「继承」不是边界；不分享与分享都会终止向上查找 */
export function isShareBoundary(mode: number): boolean {
  return normalizeShareMode(mode) !== SHARE_INHERIT
}

export function normalizeShareMode(value: any): ShareMode {
  // 只有真实的 0/1/2 映射到自身；null / undefined / '' / NaN / 其它一律当「继承」。
  // 先挡掉这几个，否则 Number(null) 和 Number('') 都会变成 0 被误判成「不分享」。
  if (value === null || value === undefined || value === '') return SHARE_INHERIT
  // 对象/数组/布尔同样要挡：Number([]) 和 Number([0]) 都等于 0（0 是 SHARE_NONE），
  // Number(true) 等于 1（1 是 SHARE_SHARED）。不挡的话一个 [] 传进来就会凭空
  // 立一道「不分享」的墙把权限砍掉，一个 true 会凭空把权限放开。
  if (typeof value === 'object' || typeof value === 'boolean') return SHARE_INHERIT
  const n = Number(value)
  if (n === SHARE_NONE || n === SHARE_SHARED || n === SHARE_INHERIT) return n
  // 取不到值时一律按「继承」处理，而不是「分享」。
  // 继承是失效开放（继续向上找，最终无人可越权），分享是失效封闭（会凭空
  // 立一个边界把权限砍掉）。旧语义下未标记本身就是「不是边界，往上找」，
  // 所以这里退回继承既安全又与迁移前的行为一致。
  // 根层没有 folders 行，也走这条分支：它没有上游可继承，因此自然是「不分享」。
  return SHARE_INHERIT
}

// 权限位掩码。四个**相互独立**的位，不再是 read ⊂ write ⊂ delete 那条单轴。
//
// 为什么独立：download 是正交的。「能看但不许下载」是真实存在的需求 ——
// 预览走的就是 /api/files/download（会扣下载流量），所以能不能预览由
// download 位决定，而能不能看由 read 位决定。两者要能分开配。
//
// 单轴模型（勾了 delete 就等于全部）表达不了这种组合，所以
// normalizePermission 不再压档，见下面的说明。
export const PERM_READ = 1      // 看：列目录、读元信息
export const PERM_WRITE = 2     // 写：上传、重命名、移动
export const PERM_DELETE = 4    // 删：删文件/目录
export const PERM_DOWNLOAD = 8  // 下载：/api/files/download，**预览也走它**（会扣下载流量）

export const PERM_ALL = PERM_READ | PERM_WRITE | PERM_DELETE | PERM_DOWNLOAD

/**
 * 加 download 位之前的「全权」，值 7。
 *
 * 存量授权名单存的都是 1/3/7，不含 download 位。加了新位之后这些行按字面
 * 解释会变成「不能下载」，等于存量被授权人突然既下不了也预览不了。所以读端
 * 兼容：只要勾了 delete（旧模型里的「全权」），就补上 download 位。
 *
 * 数据库不用动（schema 的 CHECK 是 permission >= 0，加位无需重建表），
 * 也没有写迁移 —— 一旦某个名单被重新保存，它就会按新语义落库。
 */
const LEGACY_FULL_MASK = PERM_READ | PERM_WRITE | PERM_DELETE

/** 新增位。给旧数据补位时用，UI 提交时不要走这里 */
export const PERM_BITS = [PERM_READ, PERM_WRITE, PERM_DELETE, PERM_DOWNLOAD] as const

export type SharePermission = typeof PERM_READ | typeof PERM_WRITE | typeof PERM_DELETE | typeof PERM_DOWNLOAD

export interface AccessGrant {
  userId: number
  permission: number
}

/**
 * 归一化权限位：**按位独立**，不再压成「只读/读写/读写删」三档。
 *
 * 以前是单轴的（勾了 delete 就返回 PERM_ALL），那套逻辑会把「可读+可下载
 * 但不能写」压成只读，download 位直接被丢掉。现在只做两件事：
 *   1. 丢掉未定义的位（挡住脏数据）
 *   2. 给旧数据补 download 位（见 LEGACY_FULL_MASK）
 */
export function normalizePermission(mask: number): number {
  const m = Number(mask) || 0
  if (!Number.isFinite(m) || m <= 0) return 0

  let out = 0
  for (const bit of PERM_BITS) if (m & bit) out |= bit

  // 旧数据兼容：旧模型的「全权」是 7，含义上等价于新模型的全权 15。
  // 判定条件是「三个旧位全勾」—— 旧模型里 delete 那档写的就是 7，
  // 只读(1)/读写(3) 明确不含下载意图，保持原样。
  //
  // 由此带来一个已知取舍：新 UI 里主动配出 7（可读可写可删但不许下载）也会被
  // 补上 download 位。位掩码本身区分不了「存量 7」和「新配 7」，要区分得加
  // 版本位或独立列 —— 对这个组合的实用价值来说属于过度设计，需要时再加。
  if (out === LEGACY_FULL_MASK) out |= PERM_DOWNLOAD

  return out
}

/**
 * 分享链接能给的权限，**锁死**：只读 + 下载。
 *
 * 为什么不给写/删：链接是匿名 bearer token，拿到的人没有身份可以追责，
 * 给写权限等于把整个子树交出去还能改。也不给「只读但能下载」的组合以外的自由 ——
 * 链接就只有这一种形态，不需要用户配置。
 *
 * 有下载位是因为预览走的就是 /api/files/download（会扣下载流量），
 * 不给下载位的话对方连预览都做不到。
 */
export const LINK_PERMISSION = PERM_READ | PERM_DOWNLOAD

/** 链接 token 的字节数。生成出来是 2 倍长度的 hex */
export const SHARE_LINK_TOKEN_BYTES = 16

/**
 * 分享链接的 query 参数名，落地地址是 `/?share_link=<token>`。
 *
 * 为什么用 query 而不是路径（原来的 `/s/<token>` 想法）：
 * 落地页就是首页，首页本来就在 auth.global.ts 的白名单里，匿名访客
 * 带这个参数就能进 —— 用路径前缀的话得额外把 `/s/**` 加进白名单，
 * 多一处「哪些路径匿名可进」的配置，多一处以后会忘的地方。
 *
 * 放这里而不是各写一份字符串：服务端拼 url 时用，前端解析 query 时用，
 * 两边不一致的表现是「链接复制出来点开是首页但什么都没发生」，
 * 很难一眼看出是哪边写错了。
 */
export const SHARE_LINK_QUERY_KEY = 'share_link'

/**
 * 分享链接的落地地址（相对路径）。
 *
 * 只有一个拼法，服务端生成与前端「写进地址栏」都用它，
 * 免得出现「服务端发的链接点开是首页，前端自己的按钮却是另一种形态」。
 */
export const SHARE_LINK_LANDING_PATH = '/'

/**
 * 校验/规范化一个链接 token，不合法返回 null。
 *
 * 格式就是 `randomBytes(16).toString('hex')` —— 32 位小写 hex。**只 trim，
 * 不 lowercase**：token 全是数字和 a-f，转成大写仍然匹配得到虽然无害，
 * 但「大小写写错了」和「token 无效」两种提示混在一起更难排查。
 *
 * 严格校验是有意义的：token 直接进 SQL 参与查询，挡掉形状不对的输入
 * 能省掉一次注定落空的查库，也顺带挡掉超长串（有人拿它当缓冲区塞东西）。
 */
export function normalizeShareLink(value: any): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.length !== SHARE_LINK_TOKEN_BYTES * 2) return null
  if (!/^[0-9a-f]+$/.test(s)) return null
  return s
}

export function hasPermission(mask: number, need: number): boolean {
  const granted = normalizePermission(mask)
  const required = normalizePermission(need)
  return (granted & required) === required
}

export function readOnly(mask: number): boolean {
  return hasPermission(mask, PERM_READ) && !hasPermission(mask, PERM_WRITE)
}

/**
 * 「这个文件我能不能下载」。
 *
 * 判据是 **fileKey 在不在**，不是权限位 —— 服务端对没有下载位的人不再下发
 * fileKey（那是 COS 里的真实对象路径，见 server/api/files/index.get.ts 的
 * withMeta 注释）。所以前端判断能不能下载/预览，看这个字段就够了。
 *
 * 为什么不让前端去比 perm 位：perm 是服务端算好的，fileKey 是不是 null
 * 是同一个判断的结果。两者可能因为历史数据/异常分支不一致，而**能不能下载
 * 只有服务端知道**。让前端看「服务端有没有给我下载所需的凭据」比让它
 * 复现一遍权限算法可靠。
 */
export function canDownloadFile(file: { fileKey?: string | null } | null | undefined): boolean {
  return Boolean(file?.fileKey)
}

/** 没有下载权限时统一用这句。分享设置弹层里也有类似说明 */
export const NO_DOWNLOAD_MESSAGE = '你没有这个文件的下载权限。需要对方在分享设置里勾选「下载」。'

/**
 * 权限位的标签，以及把掩码渲染成一句中文。
 *
 * PERMISSION_LABELS 保留是为了兼容 share/list.get.ts（它按掩码查标签返回），
 * 但四位独立后掩码有 16 种，穷举不现实 —— 新代码用 formatPermission()。
 */
export const PERMISSION_LABELS: Record<number, string> = {
  [PERM_READ]: '只读',
  [PERM_READ | PERM_WRITE]: '读写',
  [PERM_READ | PERM_WRITE | PERM_DELETE]: '读写删',
  [PERM_ALL]: '读写删+下载'
}

/** 单个位的中文名。UI 的复选框和权限摘要都用它 */
export const PERM_BIT_LABELS: Record<number, string> = {
  [PERM_READ]: '查看',
  [PERM_WRITE]: '编辑',
  [PERM_DELETE]: '删除',
  [PERM_DOWNLOAD]: '下载'
}

/**
 * 掩码 → 中文摘要。
 *
 * 顺序固定为 查看/编辑/删除/下载，与 UI 复选框的排列一致。
 * 四位全勾显示「全部」，其余逐位拼。
 *
 * 「下载」这一项要连预览一起管：预览走的就是 /api/files/download，
 * 会扣下载流量，所以两者用同一个位。
 */
export function formatPermission(mask: number): string {
  const m = normalizePermission(mask)
  if (m === 0) return '无权限'
  if (m === PERM_ALL) return '全部权限'
  return PERM_BITS.map((bit) => (m & bit ? PERM_BIT_LABELS[bit] : null))
    .filter(Boolean)
    .join(' / ')
}

/**
 * 一条有效权限的**来源**，用来回答「我为什么能看到 / 能改这个」。
 * 按「谁最具体谁赢」定优先级：自身名单 > 边界祖先 > 边界之下的授权 > 公开。
 *
 * `link` 是唯一的非用户来源：分享链接没有 userId，所以走不到前面那套
 * 按人查名单的判定，是单独一条链路给出的固定掩码 LINK_PERMISSION。
 */
export type PermSource = 'owner' | 'self' | 'inherited' | 'public' | 'link' | 'none'
