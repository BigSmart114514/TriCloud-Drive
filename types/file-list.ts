export type FileListId = string | number

export interface FileListFolder {
  id: FileListId
  name: string
  createdAt?: string | null
}

export interface FileListFile {
  id: FileListId
  filename: string
  fileSize: number
  createdAt?: string | null
  contentType?: string
  Shared?: boolean
  IsPublic?: boolean
  allowedUsers?: number[]
}
