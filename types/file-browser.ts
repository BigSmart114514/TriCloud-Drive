// ~/types/file-browser.ts
export interface FolderRecord {
  id: number
  name: string
  parentId: number | null
  createdAt: string
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
  Shared?: boolean
  IsPublic?: boolean
  allowedUsers?: number[]
}