// 共享模式（三态）。授权名单与边界标记是**两件独立的事**：
// 授权行写在 file_access / folder_access 里，谁被授权由名单决定；
// 「要不要在此切断向上继承」才由本字段决定。二者解耦后，
// 给某个节点单独加一个人就不会再意外切断上层已共享的其他人。
export const SHARE_NONE = 0        // 不分享：拒绝型边界，除属主外谁都拿不到
export const SHARE_SHARED = 1      // 分享：名单内放行（含 IsPublic 给所有人的 READ），名单外到此为止
export const SHARE_INHERIT = 2     // 继承：不是边界，继续向上查找；本节点名单仍然叠加生效

export type ShareMode = typeof SHARE_NONE | typeof SHARE_SHARED | typeof SHARE_INHERIT

/** 新建节点默认继承：在共享文件夹里新建的东西，团队立即可见 */
export const DEFAULT_SHARE_MODE: ShareMode = SHARE_INHERIT

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
