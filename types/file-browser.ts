// ~/types/file-browser.ts
export interface FolderRecord {
  id: number
  name: string
  parentId: number | null
  createdAt: string
  /** 属主 id */
  userId?: number
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
  Shared?: boolean
  IsPublic?: boolean
  allowedUsers?: number[]
}