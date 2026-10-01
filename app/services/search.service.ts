import type { FileListFile, FileListFolder } from '~~/types/file-list'

/**
 * 搜索的两种范围。
 *
 *   mine —— 只搜自己拥有的树（user_id = 我）。首页用
 *   site —— 全站。仅超级管理员；普通管理员调用会被服务端 403
 */
export type SearchScope = 'mine' | 'site'

/** 面包屑的一级，服务端算好的「从根到目标」链路 */
export interface SearchPathNode {
  id: number
  name: string
}

/**
 * 目录命中。
 *
 * 字段与 FileListFolder 兼容（多出来的 path / ownerId 是跳转要用的，
 * 渲染时会忽略），所以可以直接喂给 FileList。
 */
export interface SearchFolderHit extends FileListFolder {
  id: number
  /**
   * 从根到该目录的完整链路，**含目录自己** —— 点开就是进它，
   * 所以直接拿它当面包屑。
   */
  path: SearchPathNode[]
  /** 该目录在它自己树里的父路径（不含自己），显示用 */
  relDir: string
  /** 属主 id。全站搜索时一行一个属主，页面据此决定要不要切侧栏 */
  ownerId: number
  /** 属主显示名。mine 范围下服务端也会给，但前端不显示（就是我） */
  ownerLabel: string | null
}

/**
 * 文件命中。
 *
 * 比 FileListFile 多的是跳转与预览要用的几个字段：
 *   path     —— 到**所在目录**为止（文件不是容器，链路以目录收尾）
 *   folderId —— 预览里「替换/保存」要写回它自己的目录，不能用当前浏览的目录
 *   fileKey  —— 换下载签名用
 */
export interface SearchFileHit extends FileListFile {
  id: number
  filename: string
  fileSize: number
  /** 所在目录。null = 位于根层 */
  folderId: number | null
  /** COS 真实对象路径。服务端只在该给的时候给（见 server/utils/search.ts） */
  fileKey: string
  path: SearchPathNode[]
  relDir: string
  ownerId: number
  ownerLabel: string | null
}

export interface SearchResult {
  success: boolean
  scope: SearchScope
  keyword: string
  folders: SearchFolderHit[]
  files: SearchFileHit[]
  /** 结果被上限截断了（服务端只说「截了」，不报总数） */
  truncated: boolean
  /** 每类的条数上限。截断文案里的 N 用它，前端不另抄一份常量 */
  limit: number
}

export const SearchService = {
  /**
   * 按名称搜文件和目录。
   *
   * 不长轮询、不做缓存：关键词由对话框去抖后调用，一次输入至多一两次请求。
   * 范围只由 scope 一个词决定，没有 targetUserId 之类的可调参数 ——
   * 少一个参数就少一类越权（见 server/api/files/search.get.ts 的说明）。
   */
  async search(q: string, scope: SearchScope) {
    return await $fetch<SearchResult>('/api/files/search', {
      params: { q, scope }
    })
  }
}
