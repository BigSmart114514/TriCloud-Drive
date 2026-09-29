// ~/types/file-browser.ts
export interface FolderRecord {
  id: number
  name: string
  parentId: number | null
  createdAt: string
  /** 属主 id */
  userId?: number
  /** 分享设置只有属主能改 */
  ownerId?: number
  /** 我对它有没有写权限 */
  canWrite?: boolean
}

export interface FileRecord {
  id: number
  folderId: number | null
  filename: string
  fileKey: string
  fileSize: number
  fileUrl: string
  contentType: string
  createdAt: string
  /** 属主 id */
  userId?: number
  /** 分享设置只有属主能改 */
  ownerId?: number
  /** 我对它有没有写权限 */
  canWrite?: boolean
  Shared?: boolean
  IsPublic?: boolean
  allowedUsers?: number[]
}