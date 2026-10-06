// 拖拽落点的分类：**纯函数，不碰 DataTransfer**。
//
// ## 为什么要抽出来
//
// 原来这段逻辑写在 useDnDUpload 的 handleDrop 里，长这样：
//
//     if (items.some((it) => typeof it.webkitGetAsEntry === 'function' && it.webkitGetAsEntry()?.isDirectory)) {
//       const entries = await getFilesFromDataTransferItems(items)
//       if (entries.length) { await handleEntries(entries); return }
//     }
//     const fls = Array.from(event.dataTransfer?.files || [])
//     if (fls.length > 0) await handleFiles(fls)
//
// 那句 `.some()` 有两个独立的问题，每一个都得靠**行为**钉住、读代码看不出来：
//
// 1. **它实体化每一个 item。** `webkitGetAsEntry()` 不是「看一眼这个条目的
//    元数据」，而是「把这个 item 变成我能逐字节读的对象」。Chrome 在 macOS 上
//    不给网页真实本地路径（那是提权），于是把每个 item 实体化成一份**真实的
//    沙箱副本**，用户能在 ~/Downloads 里看到。`some()` 只在找到第一个目录时
//    短路，所以**拖纯文件是代价最大的那种** —— 为了确认「没有目录」，它必须
//    把每一个都问一遍。
//
//    连带后果：传到 COS 的其实是那份副本，副本的生命周期由浏览器管、与原文件
//    两套时间戳。长传（项目一直用单发 putObject，不分片）时 Chrome 会发现快照
//    与当前状态对不上，掐断上传并报 `net::ERR_UPLOAD_FILE_CHANGED`。而
//    cos-js-sdk-v5 拿到的 statusText 是空的、status === 0，于是 fallback 到那句
//    硬编码的 `'CORS blocked or network error'`（lib/request.js:136）——
//    文案指向了一个和真实原因无关的方向。
//
// 2. **它在读 `dataTransfer.files` 之前就碰了 `.items`。** 按 HTML 规范，
//    调 getAsEntry() 会把 item 锁进 protected 状态，在 Chrome 里这会让随后的
//    `dataTransfer.files` 返回**空**。
//
// 菜单那条路（handleFileSelect）走 `<input type=file>` 的 `.files`，全程不碰
// `webkitGetAsEntry`，所以既不产生副本、也没有 protected 的问题。这正是
// 「菜单是好的、拖拽会复制」的全部差别 —— 上传代码本身两条路完全一样。
//
// ## 这里的判据：kind / type 都是无副作用的读取
//
// `kind` 和 `type` 是纯属性读，不触发实体化。目录的形状是
// **kind === 'file' 且 type === ''**（目录没有 MIME 类型）；普通文件是
// kind === 'file' 且 type 非空。
//
// `type === ''` 不 100% 等价于「是目录」：MIME 未知的普通文件（少见但存在）
// 也可能是空串。所以下面刻意**不把它当判定**，只当「需要进一步实体化确认」的
// 提示 —— 真正的区分仍然交给 webkitGetAsEntry，但**只对可能含目录的那一批
// 调用**，且每个 item 最多调一次。
//
// 无法区分时退回「按文件夹处理」，宁可多实体化一次，也不要静默丢掉目录结构。

/** 一个 DataTransferItem 的最小形状。只用到这两个无副作用属性。 */
export interface DroppableItemLike {
  kind?: string
  type?: string
}

/** 判据：这个 item 有没有可能是目录。 */
function mayBeDirectory(item: DroppableItemLike): boolean {
  // kind !== 'file' 的是文本/URL 之类，dataTransfer.files 里本来就没有
  return item.kind === 'file' && !item.type
}

/**
 * 决定这次 drop 怎么处理。
 *
 * @param items  event.dataTransfer.items（可以为空数组 —— 拿不到就退化成旧行为）
 * @returns
 *   - `mode: 'files'`  直接用 dataTransfer.files，**不实体化任何 item**。
 *                     拖纯文件走这条，所以不会有 ~/Downloads 副本。
 *   - `mode: 'dirs'`   里面有可能是目录的 item，需要实体化那一批。
 *   - `needsEntry`     需要调 webkitGetAsEntry 的 item（'dirs' 时非空）。
 *                     空数组表示整批都不需要碰 —— 别拿它当「要实体化全部」。
 */
export function classifyDrop(
  items: DroppableItemLike[]
): { mode: 'files' | 'dirs'; needsEntry: DroppableItemLike[] } {
  const needsEntry = items.filter(mayBeDirectory)
  // items 为空（浏览器不给、或 dragCounter 那类合成事件）→ 保守走 files，
  // 与「只有纯文件」同一条路，不引入新的实体化。
  if (!needsEntry.length) return { mode: 'files', needsEntry: [] }
  return { mode: 'dirs', needsEntry }
}

/** 路径分隔符归一 + 去掉首尾斜杠。Windows 的 `\` 与 POSIX 的 `/` 都吃。 */
export const toPosix = (p: string) => p.replace(/\\/g, '/')
export const normalizeDir = (p: string) => toPosix(p).replace(/^\/+|\/+$/g, '')

/**
 * 从 `<input webkitdirectory>` 的 FileList 造条目。
 *
 * 与拖拽路径共用，因为「一批 File + 各自的相对目录」这个形状是同一个 ——
 * 两边各写一遍的话，改了目录归一规则只有一边会跟上（这正是 useDualSelection
 * 与 useBulkActions 的历史教训）。
 */
export function entriesFromWebkitRelativePath(files: File[]): Array<{ file: File; relativePath: string }> {
  return files.map((f: any) => {
    const rpRaw: string = f.webkitRelativePath || f.name
    const rp = toPosix(rpRaw)
    const dir = rp.includes('/') ? rp.slice(0, rp.lastIndexOf('/')) : ''
    return { file: f as File, relativePath: normalizeDir(dir) }
  })
}