// ~/composables/useArchiveTree.ts
//
// 压缩包预览的目录树逻辑。zip.js 与 7z-wasm 两个预览组件共用这一份。
//
// ## 为什么要抽出来
//
// ZipPreview.vue 与 SevenZipPreview.vue 各 310 / 395 行，其中约 190 行完全
// 相同：状态、createRoot、normalizePath、ensureDirectory、sortNode、五个
// computed、四个导航函数、watch、以及 48 行模板。真正的差异只有「怎么把 blob
// 读成记录」—— zip.js 给 entry 对象，7z-wasm 给 `l -slt` 的文本，两者各约
// 95 行。同一份树逻辑抄两遍，改一处忘一处的话两个预览器的行为就分叉了
// （而它们本该完全一致）。
//
// ## 边界怎么划
//
// 抽到这里的是**与压缩格式无关**的部分：路径规范化、安全检查（拒绝绝对路径、
// `..`、盘符）、树构建、按名字过滤、面包屑、导航。
//
// 格式相关的一律留在各自组件里：引擎初始化、条目上限的具体解读、密码、
// read() 怎么取字节。它们的差异是真实且必须留的，不强行统一。
import { computed, ref, shallowRef, triggerRef } from 'vue'
import type { FileListFile, FileListFolder } from '~~/types/file-list'
import type { ArchiveFileItem, ArchiveFormat } from '~~/types/zip'

export interface ArchiveDirectory extends FileListFolder {
  path: string
  children: ArchiveDirectory[]
  files: ArchiveFileItem[]
}

/** 面包屑上的一节。ArchiveBrowser.vue 的 props 用它，所以单独命名 */
export interface ArchiveCrumb {
  name: string
  /** '' = 根。goToPath 收的就是这个值 */
  path: string
}

export interface UseArchiveTreeOptions {
  /** 根节点 id。两个预览器给不同的值，避免 key 冲突（'zip-root' / 'sevenzip-root'） */
  rootId: string
  /** 最多处理多少条目。超出的计入 skippedCount 并在界面上提示 */
  maxEntries: number
}

export function useArchiveTree(options: UseArchiveTreeOptions) {
  const loading = ref(false)
  const error = ref('')
  const search = ref('')
  const totalCount = ref(0)
  const skippedCount = ref(0)
  const currentPath = ref('')
  const treeRevision = ref(0)
  const root = shallowRef<ArchiveDirectory | null>(null)
  const directoryLookup = new Map<string, ArchiveDirectory>()
  const fileLookup = new Map<string, ArchiveFileItem>()

  const createRoot = (): ArchiveDirectory => ({
    id: options.rootId,
    name: '压缩包',
    path: '',
    createdAt: null,
    children: [],
    files: []
  })

  /**
   * 把压缩包里的原始路径规范化，危险的返回 null。
   *
   * 拒绝四类：空、绝对路径（`/foo`）、盘符（`C:\foo`）、含 `..` 的（跳出根）。
   * zip 与 7z 都能塞进这样的条目，解压时就是目录穿越，所以必须在这里挡掉 ——
   * 7z 的 read() 走的是引擎内部路径，绕过了浏览器的任何沙箱。
   */
  const normalizePath = (value: string): string | null => {
    const raw = value.replace(/\\/g, '/')
    if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
    const normalized = raw.replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '')
    const parts = normalized.split('/').filter(Boolean)
    if (parts.some(part => part === '.' || part === '..')) return null
    return parts.join('/')
  }

  /** 按路径建/取目录，途中缺失的层级自动补齐 */
  const ensureDirectory = (path: string, createdAt: string | null): ArchiveDirectory => {
    const existing = directoryLookup.get(path)
    if (existing) {
      if (!existing.createdAt && createdAt) existing.createdAt = createdAt
      return existing
    }

    let current = root.value!
    let currentPath = ''
    for (const name of path ? path.split('/') : []) {
      currentPath = currentPath ? `${currentPath}/${name}` : name
      let child = current.children.find(item => item.name === name)
      if (!child) {
        child = {
          id: `folder:${currentPath}`,
          name,
          path: currentPath,
          createdAt,
          children: [],
          files: []
        }
        current.children.push(child)
        directoryLookup.set(currentPath, child)
      } else if (!child.createdAt && createdAt) {
        child.createdAt = createdAt
      }
      current = child
    }
    return current
  }

  const sortNode = (node: ArchiveDirectory) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    node.files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }))
    node.children.forEach(sortNode)
  }

  /**
   * 开始一次加载：置 loading 并清空上一棵树。
   *
   * **必须在开始解析之前调**，不能等 parse 完再调 —— 换压缩包时旧树要立刻消失，
   * 否则解析期间界面上还挂着上一个包的内容，看着像卡住了。
   *
   * （原先两个组件各写一遍，顺序还微妙地不同：zip 是 closeReader 之后置 loading
   * 再清，7z 是先置 loading 再 closeEngine 然后清。现在统一成「close 完 →
   * beginLoad → 解析」。）
   */
  const beginLoad = () => {
    loading.value = true
    error.value = ''
    search.value = ''
    currentPath.value = ''
    totalCount.value = 0
    skippedCount.value = 0
    directoryLookup.clear()
    fileLookup.clear()
    root.value = createRoot()
    directoryLookup.set('', root.value)
    treeRevision.value += 1
  }

  /**
   * 吃进一批条目并建树。
   *
   * 调用方负责解析自己的格式成 `raw` 数组（路径/大小/时间/是否目录/read），
   * 剩下的（规范化、安全检查、层级、上限截断、排序）都在这里 —— 两边因此
   * 不会再有「zip 挡了但 7z 没挡」这种分叉。
   *
   * format 由调用方传（'zip' / '7z'）：它标的是**这条记录来自哪种引擎**，
   * 下载时要用对应的解压器，所以不能由共用的这层替它决定。
   */
  const ingest = (
    raw: Array<{
      path: string
      fileSize: number
      compressedSize: number
      modifiedAt: string
      encrypted: boolean
      directory: boolean
      read: (opts?: { password?: string; signal?: AbortSignal }) => Promise<Blob>
    }>,
    format: ArchiveFormat
  ) => {
    const available = raw.slice(0, options.maxEntries)
    skippedCount.value = Math.max(0, raw.length - available.length)
    totalCount.value = raw.length

    available.forEach((record, index) => {
      const normalized = normalizePath(record.path)
      if (normalized === null) {
        skippedCount.value += 1
        return
      }

      const segments = normalized ? normalized.split('/') : []
      if (record.directory) {
        for (let i = 0; i < segments.length; i += 1) {
          ensureDirectory(segments.slice(0, i + 1).join('/'), record.modifiedAt || null)
        }
        return
      }

      if (segments.length === 0) return
      const filename = segments.pop()!
      const parent = ensureDirectory(segments.join('/'), record.modifiedAt || null)
      const key = `entry:${index}`
      const item: ArchiveFileItem = {
        id: key,
        key,
        path: normalized,
        filename,
        fileSize: Math.max(0, Number(record.fileSize) || 0),
        compressedSize: Math.max(0, Number(record.compressedSize) || 0),
        modifiedAt: record.modifiedAt || '',
        encrypted: !!record.encrypted,
        format,
        read: record.read
      }
      parent.files.push(item)
      fileLookup.set(key, item)
    })

    // root 一定存在：调用方必须先 beginLoad。这里不写 `root.value!` 而是真的判一下，
    // 因为 ingest 也可能抛错（上面 forEach 之外还有 Math.max 等调用），
    // 万一没走到 beginLoad 就在这里静默建一棵空树，比抛 TypeError 好排查。
    //
    // 顺带一提：这段在两个组件里时 tsc 看不见（.vue 不参与 tsc 检查），
    // 所以 `sortNode(root.value)` 的 null 一直没人报。搬进 .ts 就立刻暴露了。
    const tree = root.value
    if (tree) sortNode(tree)
    treeRevision.value += 1
    triggerRef(root)
  }

  /** 结束一次加载。调用方在 finally 里调，requestId 对不上时不该动 loading */
  const endLoad = () => {
    loading.value = false
  }

  /**
  * 读取失败时回到空树，界面显示 error 而不是半棵残树。
  *
  * **必须同时清掉 directoryLookup**。currentDirectory 是
  * `directoryLookup.get(currentPath) || root`，而 currentPath 恒为 ''，
  * 所以 lookup 里的 '' 一旦还指着旧 root，换掉的 root 就等于没换 ——
  * 列表仍显示上一次解析出来的内容。
  *
  * 这个不一致是从两个组件的旧代码里继承的（原样是 `root.value = createRoot()`，
  * 没动 lookup）。界面上没暴露是因为模板写着 `v-if="!error"`：出错的树压根
  * 不渲染。靠「反正不显示」来掩盖状态不一致，测试一查就露出来了。
  */
  const failTree = (message: string) => {
    error.value = message
    directoryLookup.clear()
    root.value = createRoot()
    directoryLookup.set('', root.value)
    treeRevision.value += 1
  }

  const currentDirectory = computed(() => {
    const tree = root.value
    return directoryLookup.get(currentPath.value) || tree || createRoot()
  })

  const filteredChildren = computed(() => {
    // 显式读 treeRevision：它每次变更都 treeRevision++，用来让这个 computed
    // 重算。root 是 shallowRef，深层字段变化不会自动触发依赖。
    treeRevision.value
    const query = search.value.trim().toLocaleLowerCase()
    const children = currentDirectory.value.children
    const files = currentDirectory.value.files
    if (!query) return { folders: children, files }
    return {
      folders: children.filter(folder => folder.name.toLocaleLowerCase().includes(query)),
      files: files.filter(file => file.filename.toLocaleLowerCase().includes(query))
    }
  })

  /** 映射成 FileList 认的行：只挑列表要用的字段，别把 path/read 一起塞进去 */
  const visibleFolders = computed<FileListFolder[]>(() =>
    filteredChildren.value.folders.map(folder => ({
      id: folder.id,
      name: folder.name,
      createdAt: folder.createdAt
    }))
  )

  const visibleFiles = computed<FileListFile[]>(() =>
    filteredChildren.value.files.map(file => ({
      id: file.id,
      filename: file.filename,
      fileSize: Number.isFinite(file.fileSize) ? Math.max(0, file.fileSize) : 0,
      createdAt: file.modifiedAt || null,
      contentType: ''
    }))
  )

  const visibleCount = computed(() => visibleFolders.value.length + visibleFiles.value.length)

  const breadcrumbs = computed<ArchiveCrumb[]>(() => {
    const result = [{ name: '压缩包根目录', path: '' }]
    let path = ''
    for (const part of currentPath.value ? currentPath.value.split('/') : []) {
      path = path ? `${path}/${part}` : part
      result.push({ name: part, path })
    }
    return result
  })

  const goToPath = (path: string) => {
    if (directoryLookup.has(path)) currentPath.value = path
  }

  /** FileList 的 id 是 `folder:<path>`，导航要还原回 path */
  const navigateFolder = (folder: FileListFolder) => {
    goToPath(String(folder.id).replace(/^folder:/, ''))
  }

  /** 返回原始条目（含 read()），由调用方 emit 出去 */
  const findFile = (file: FileListFile) => fileLookup.get(String(file.id))

  return {
    loading,
    error,
    search,
    totalCount,
    skippedCount,
    currentPath,
    root,
    visibleFolders,
    visibleFiles,
    visibleCount,
    breadcrumbs,
    beginLoad,
    ingest,
    failTree,
    endLoad,
    goToPath,
    navigateFolder,
    findFile
  }
}
