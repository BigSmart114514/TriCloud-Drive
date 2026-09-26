// 共享权限：位掩码。包含关系 read ⊂ write ⊂ delete
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
