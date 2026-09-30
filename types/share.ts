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

// 权限位掩码。包含关系 read ⊂ write ⊂ delete
// 存库时一律用 normalizePermission 归一化，勾了 delete 就写 7 而不是 4
export const PERM_READ = 1
export const PERM_WRITE = 2
export const PERM_DELETE = 4
export const PERM_ALL = PERM_READ | PERM_WRITE | PERM_DELETE

export type SharePermission = typeof PERM_READ | typeof PERM_WRITE | typeof PERM_DELETE

export interface AccessGrant {
  userId: number
  permission: number
}

export function normalizePermission(mask: number): number {
  const m = Number(mask) || 0
  if (m & PERM_DELETE) return PERM_ALL
  if (m & PERM_WRITE) return PERM_READ | PERM_WRITE
  if (m & PERM_READ) return PERM_READ
  return 0
}

export function hasPermission(mask: number, need: number): boolean {
  const granted = normalizePermission(mask)
  const required = normalizePermission(need)
  return (granted & required) === required
}

export function readOnly(mask: number): boolean {
  return hasPermission(mask, PERM_READ) && !hasPermission(mask, PERM_WRITE)
}

export const PERMISSION_LABELS: Record<number, string> = {
  [PERM_READ]: '只读',
  [PERM_READ | PERM_WRITE]: '读写',
  [PERM_ALL]: '读写删'
}

/**
 * 一条有效权限的**来源**，用来回答「我为什么能看到 / 能改这个」。
 * 按「谁最具体谁赢」定优先级：自身名单 > 边界祖先 > 边界之下的授权 > 公开。
 */
export type PermSource = 'owner' | 'self' | 'inherited' | 'public' | 'none'
