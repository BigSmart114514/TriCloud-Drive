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
  user_id: number
  Shared?: boolean
  IsPublic?: boolean
  allowedUsers?: number[]
}

export interface FolderManifest {
  success: boolean
  folder: { id: number; name: string }
  files: { id: number; filename: string; fileKey: string; fileSize: number; relDir: string }[]
  totals: { count: number; bytes: number }
  precheck: {
    allowed: boolean
    unlimited: boolean
    requiredBytes: number
    remainingBytes: number
    exceedBytes: number
    usedDownload: number
    maxDownload: number
  }
}