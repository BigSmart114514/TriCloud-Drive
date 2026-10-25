// 预览字节的一层缓存。
//
// ## 它解决什么
//
// 一个文件在预览器之间来回切（图片 → 文本 → PDF）时，字节是同一份。没有这层
// 缓存，每次切换都会重新签名、重新把整个对象拉一遍 —— 一个 500MB 的 PDF 切到
// 文本视图就是再传一次 500MB。
//
// 界面上看不出区别，只是慢和费流量，所以很容易一直没人发现。
//
// ## 缓存只留一份
//
// 预览器同时只开一个文件，所以没必要按 key 存多份。换文件时旧的那份被替换，
// 再切回旧文件会重新下载 —— 这是刻意的取舍：多留几份等于把看过的每个文件都
// 钉在内存里，而用户根本意识不到。
//
// ## 在途请求也要复用
//
// 「双击下拉，先选文本再选图片」会连续触发两次取数。如果两次都真的发请求，
// 缓存等于白做。所以同一个 key 在途时，第二次直接等同一个 promise。
//
// 换 **key** 时相反：旧请求必须 abort，否则两个大文件会同时在传。

export interface PreviewSourceDeps {
  /** 用 fileKey 换一个可下载的 URL。失败时抛。 */
  sign: (fileKey: string) => Promise<string>
  /** 拉取字节。失败时抛。 */
  fetchBlob: (url: string, signal: AbortSignal) => Promise<Blob>
}

export interface PreviewSource {
  /** 取这个文件的字节。命中缓存或在途请求时不会产生新的网络调用。 */
  get: (fileKey: string) => Promise<Blob>
  /** 当前缓存属于哪个 fileKey；没有缓存时是 null。 */
  cachedKey: () => string | null
  /** 丢掉缓存与在途请求（卸载时用）。 */
  invalidate: () => void
}

interface Cached {
  key: string
  blob: Blob
}

interface Inflight {
  key: string
  promise: Promise<Blob>
  controller: AbortController
}

export function createPreviewSource(deps: PreviewSourceDeps): PreviewSource {
  let cached: Cached | null = null
  let inflight: Inflight | null = null

  const get = (fileKey: string): Promise<Blob> => {
    if (cached?.key === fileKey) return Promise.resolve(cached.blob)
    if (inflight?.key === fileKey) return inflight.promise

    // 换了文件：旧的那次还在跑就掐掉，别让两个大文件同时占带宽。
    if (inflight) {
      inflight.controller.abort()
      inflight = null
    }

    const controller = new AbortController()
    const promise = (async () => {
      const url = await deps.sign(fileKey)
      // 签名也是异步的，这期间用户可能已经换了文件。被取消就别再发请求了 ——
      // 光把 signal 传过去不够，fetch 会立刻因为已 abort 而失败，等于白发一次。
      if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError')
      const blob = await deps.fetchBlob(url, controller.signal)
      cached = { key: fileKey, blob }
      return blob
    })()

    const entry: Inflight = { key: fileKey, promise, controller }
    inflight = entry
    // 只在「还是这一次」时清掉；已经换成别的 key 了就别动新的那笔。
    const settle = () => {
      if (inflight === entry) inflight = null
    }
    promise.then(settle, settle)

    return promise
  }

  return {
    get,
    cachedKey: () => cached?.key ?? null,
    invalidate: () => {
      inflight?.controller.abort()
      inflight = null
      cached = null
    }
  }
}
