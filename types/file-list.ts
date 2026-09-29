export type FileListId = string | number

export interface FileListFolder {
  id: FileListId
  name: string
  /** 属主 id。分享设置只有属主能改，前端据此决定是否给出分享入口 */
  ownerId?: number | null
  createdAt?: string | null
  /** 所在目录的相对路径。仅「共享清单」这类平铺视图会带，普通目录浏览不传 */
  relDir?: string
}

export interface FileListFile {
  id: FileListId
  filename: string
  fileSize: number
  /** 属主 id。分享设置只有属主能改，前端据此决定是否给出分享入口 */
  ownerId?: number | null
  createdAt?: string | null
  contentType?: string
  Shared?: boolean
  IsPublic?: boolean
  allowedUsers?: number[]
  /** 同上：所在目录的相对路径 */
  relDir?: string
}
