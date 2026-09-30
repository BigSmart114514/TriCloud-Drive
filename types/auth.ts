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
