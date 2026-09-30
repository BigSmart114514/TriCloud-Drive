import type { PermSource } from '~~/types/share'

export type FileListId = string | number

/** 弹层里显示的「你对这个条目的权限」 */
export interface FileListPerm {
  /** 完整位掩码：1 读 / 2 写 / 4 删；0 = 无权 */
  perm?: number
  permSource?: PermSource
  /**
   * 继承态下自己设的名单/公开当前生效吗。
   *
   * 没人拍板（整条链全是继承，含根目录自己）或最近边界是「不分享」时为 false，
   * 此时红点提示属主「设了但没生效」。服务端 resolveAccess 之外单独算的，
   * 某些路径可能不带这个字段 —— undefined 视为生效（不打扰）。
   */
  presetActive?: boolean
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
  /** 同 FileListPerm.presetActive */
  presetActive?: boolean
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
  /** 我授权了多少人。红点判定要「有没有设过人员」 */
  grantCount?: number
  createdAt?: string | null
  contentType?: string
  allowedUsers?: number[]
  /** 同上：所在目录的相对路径 */
  relDir?: string
}
