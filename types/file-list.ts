export type FileListId = string | number

export interface FileListFolder {
  id: FileListId
  name: string
  createdAt?: string | null
  /** 所在目录的相对路径。仅「共享清单」这类平铺视图会带，普通目录浏览不传 */
  relDir?: string
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
  /** 同上：所在目录的相对路径 */
  relDir?: string
}
