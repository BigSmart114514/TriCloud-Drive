// 文件与目录的记录类型 —— 前端与服务端共用一份。
//
// ## 为什么合并过
//
// 以前有两份：`types/files.ts` 与 `types/file-browser.ts`，同名 interface
// （FolderRecord / FileRecord）字段几乎全同，后者多 3 个可选字段。前端 6 个文件
// import 前者、4 个 import 后者，而服务端 `server/utils/file.ts` 要前者。
//
// 后果不是「多写了 25 行」那么轻：`FileBrowser.vue` 里那个
// `selectedItems` 要把 `folders`（FolderRecord[]）和 `files`（FileRecord[]）
// 合成一个数组给 composable 用，两边类型不同源，只能写
// `(folders.value as any[])` —— 那两个 `any` 就是这么来的。
//
// 现在只有一份，谁 import 都拿到同样的字段。
//
// ## 与 types/file-list.ts 的关系
//
// `FileListFile` / `FileListFolder` 是**列表行**的类型，字段更全（多了
// grantCount / linkCount / relDir / ownerLabel 这些纯展示用的）。两者是不同
// 用途，不合并：一份是「记录」，一份是「行 + 它的角标状态」。

export interface FolderRecord {
  id: number
  name: string
  parentId: number | null
  createdAt: string
  /** 属主 id。列表接口不一定给，所以可选 */
  userId?: number
  /** 分享设置只有属主能改。允许 null：服务端取不到时给 null */
  ownerId?: number | null
  /** 我对它有没有写权限 */
  canWrite?: boolean
  Shared?: boolean
  IsPublic?: boolean
  allowedUsers?: number[]
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
  /**
   * 属主 id（服务端内部用）。
   *
   * 可选而非必填：前端拿到的行里没有这个字段，只有服务端从 DB 读出来的记录
   * 才有。`server/utils/file.ts` 的 save() 会读它 —— 那里有独立的运行时检查，
   * 所以放宽类型不会让它变成 undefined 就往下传。
   */
  user_id?: number
  /** 属主 id（前端用，接口返回时给） */
  userId?: number
  /** 分享设置只有属主能改 */
  ownerId?: number | null
  /** 我对它有没有写权限 */
  canWrite?: boolean
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
    /** 额度归属那一行已过期。与 allowed 分开：过期不是「流量不够」 */
    expired: boolean
    /** 这次是谁的不够：'download_self' | 'download_parent' | null */
    fail: string | null
  }
}
