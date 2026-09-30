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
 * 要不要在图标右下角点一个红点 —— 提示「你设的分享当前没生效」。
 *
 * 三个条件同时成立才点：
 *   1. 继承态（只有继承态才存在「预设」这回事）
 *   2. 确实设过东西（授权名单非空，或开了公开）—— 什么都没设就没有「没生效」
 *   3. 预设没生效（`presetActive === false`）：整条链没人拍板，含根目录自己；
 *      或者最近的那道边界是「不分享」，把它挡住了
 *
 * `presetActive` 缺失（undefined）时**不点**：那说明这条数据没经过判定
 * （部分接口不返回它），宁可漏提示也不要给一份正常的分享挂个「没生效」。
 */
export function shouldShowPresetDot(input: {
  Shared?: number | null
  IsPublic?: boolean | null
  grantCount?: number | null
  presetActive?: boolean | null
}): boolean {
  if (normalizeShareMode(input.Shared) !== SHARE_INHERIT) return false
  const hasSetting = input.IsPublic === true || Number(input.grantCount ?? 0) > 0
  if (!hasSetting) return false
  return input.presetActive === false
}

export const PRESET_DOT_TITLE = '已设置的分享当前未生效：上方没有「分享」节点，或被「不分享」挡住了'

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

export function hasPermission(mask: number, need: number): boolean {
  const granted = normalizePermission(mask)
  const required = normalizePermission(need)
  return (granted & required) === required
}

export function readOnly(mask: number): boolean {
  return hasPermission(mask, PERM_READ) && !hasPermission(mask, PERM_WRITE)
}

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
 */
export type PermSource = 'owner' | 'self' | 'inherited' | 'public' | 'none'
