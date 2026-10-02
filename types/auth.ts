export interface User {
  id: number
  email: string
  username: string
  created_at: string
  IsAdmin: boolean
  IsSuperAdmin: boolean
  usedStorage: number
  maxStorage: number
  usedDownload: number
  maxDownload: number
  expire_at: string | null
  canChangePassword: boolean
  /** 父账号 id。null = 不是任何人的子账户 */
  parent_id: number | null
  /** 能不能建子账户。管理员在「用户管理」里给，默认 0 */
  canSubAccount: boolean
  /** 最多能建几个子账户，0 = 不限 */
  maxSubAccount: number
}

export interface AuthResponse {
  success: boolean
  statusMessage: string
  user?: User
}

export interface LoginRequest {
  username: string
  password: string
}

export interface RegisterRequest {
  email: string
  username: string
  password: string
}

export interface ApiError {
  statusCode: number
  statusMessage: string
}

export interface GeneralResponse{
  success: boolean
  statusMessage?: string | null | undefined
}

declare global {
  interface CloudflareEnv {
    DB: any
    SESSION_SECRET?: string
  }
}
