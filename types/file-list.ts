import type { PermSource } from '~~/types/share'

export type FileListId = string | number

/** 弹层里显示的「你对这个条目的权限」 */
export interface FileListPerm {
  /** 完整位掩码：1 读 / 2 写 / 4 删；0 = 无权 */
  perm?: number
  permSource?: PermSource
}

export interface FileListFolder extends FileListPerm {
  id: FileListId
  name: string
  /** 属主 id。分享设置只有属主能改，前端据此决定按钮是「管理分享」还是「看权限」 */
  ownerId?: number | null
  /** 我对它有没有写权限。共享视图里据此把剪贴/重命名/删除按条目置灰 */
  canWrite?: boolean
  /** 共享三态：0 不分享 / 1 分享 / 2 继承 */
  Shared?: number
  IsPublic?: boolean
  /** 我授权了多少人。继承态下配合 Shared 决定角标：非空 = 共享中 */
  grantCount?: number
  createdAt?: string | null
  /** 所在目录的相对路径。仅「共享清单」这类平铺视图会带，普通目录浏览不传 */
  relDir?: string
}

export interface FileListFile extends FileListPerm {
  id: FileListId
  filename: string
  fileSize: number
  /** 属主 id。分享设置只有属主能改，前端据此决定按钮是「管理分享」还是「看权限」 */
  ownerId?: number | null
  /** 我对它有没有写权限。共享视图里据此把剪贴/重命名/删除按条目置灰 */
  canWrite?: boolean
  /** 共享三态：0 不分享 / 1 分享 / 2 继承 */
  Shared?: number
  IsPublic?: boolean
  createdAt?: string | null
  contentType?: string
  allowedUsers?: number[]
  /** 同上：所在目录的相对路径 */
  relDir?: string
}
