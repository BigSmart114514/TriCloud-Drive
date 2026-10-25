// 预览字节的缓存（app/utils/preview-source.ts）。
//
// ## 为什么要单独测这个
//
// 切换预览器时不该重新下载。这句话的正确性不在组件里 —— 组件只是调用方。
// 真正保证「不重复下载」的是这一层：同一个 fileKey 第二次要字节时，既不重新
// 签名，也不再发请求。
//
// 所以这里断的是**调用次数与调用形式**：sign 被调了几次、fetchBlob 被调了几次、
// 传进去的 url 是不是 sign 给的那个、signal 是不是真的一个 AbortSignal。
// 不能只断「返回了一个 Blob」—— 那样即使每次都重新下载也照样通过。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { createPreviewSource } = await import('../app/utils/preview-source.ts')

const makeDeps = () => {
  const calls = { sign: [], fetch: [] }
  return {
    calls,
    deps: {
      sign: async (key) => {
        calls.sign.push(key)
        return `https://cdn.example/${key}`
      },
      fetchBlob: async (url, signal) => {
        calls.fetch.push({ url, signal })
        return new Blob([url], { type: 'application/octet-stream' })
      }
    }
  }
}

describe('同一个文件只下载一次', () => {
  test('连续取两次：只签名一次、只请求一次，且是同一个 Blob', async () => {
    const { calls, deps } = makeDeps()
    const source = createPreviewSource(deps)

    const first = await source.get('users/1/a.png')
    const second = await source.get('users/1/a.png')

    assert.deepEqual(calls.sign, ['users/1/a.png'], '第二次不该再签名')
    assert.equal(calls.fetch.length, 1, '第二次不该再请求')
    assert.equal(first, second, '应该返回同一份字节，而不是重新装配一个 Blob')
  })

  test('切换预览器意味着连续取多次 —— 也就是这个场景', async () => {
    const { calls, deps } = makeDeps()
    const source = createPreviewSource(deps)

    // 图片 → 文本 → PDF → 压缩包，来回切
    for (const _ of [1, 2, 3, 4, 5, 6]) await source.get('users/1/a.pdf')

    assert.equal(calls.sign.length, 1)
    assert.equal(calls.fetch.length, 1)
  })

  test('并发取同一个文件也只请求一次', async () => {
    const { calls, deps } = makeDeps()
    const source = createPreviewSource(deps)

    const [a, b] = await Promise.all([source.get('k'), source.get('k')])

    assert.equal(calls.sign.length, 1, '两个调用在途时应该共用同一次签名')
    assert.equal(calls.fetch.length, 1)
    assert.equal(a, b)
  })
})

describe('什么时候必须重新取', () => {
  test('换文件要重新取（缓存只留最后一份）', async () => {
    const { calls, deps } = makeDeps()
    const source = createPreviewSource(deps)

    await source.get('k1')
    await source.get('k2')
    assert.equal(calls.fetch.length, 2)

    // 回到 k1：只缓存了一份，所以要重新取。这条是刻意的取舍，不是漏洞。
    await source.get('k1')
    assert.equal(calls.fetch.length, 3)
  })

  test('invalidate 之后重新取', async () => {
    const { calls, deps } = makeDeps()
    const source = createPreviewSource(deps)

    await source.get('k')
    source.invalidate()
    await source.get('k')
    assert.equal(calls.fetch.length, 2)
  })

  test('换文件时旧的在途请求会被 abort', async () => {
    const signals = []
    const source = createPreviewSource({
      sign: async (k) => `https://cdn/${k}`,
      fetchBlob: (url, signal) =>
        new Promise((_, reject) => {
          signals.push(signal)
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })

    const first = source.get('k1')
    first.catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(signals.length, 1, '第一个请求应该已经发出')

    const second = source.get('k2')
    second.catch(() => {})
    await new Promise((r) => setTimeout(r, 0))

    assert.equal(signals.length, 2, '换文件应该发起新请求')
    assert.equal(signals[0].aborted, true, '旧文件那个请求必须被取消，否则两个大文件同时在传')
    assert.equal(signals[1].aborted, false)
  })

  test('签名还没回来就换文件：旧请求根本不该发出', async () => {
    const signals = []
    let releaseSign
    const source = createPreviewSource({
      sign: (k) => new Promise((resolve) => {
        if (k === 'k1') releaseSign = () => resolve('https://cdn/k1')
        else resolve('https://cdn/k2')
      }),
      fetchBlob: (url, signal) => {
        signals.push({ url, signal })
        return Promise.resolve(new Blob([url]))
      }
    })

    const first = source.get('k1')
    first.catch(() => {})
    // 不 await：此时 k1 还卡在签名上，立刻换文件
    const second = source.get('k2')
    releaseSign?.()
    await second
    await new Promise((r) => setTimeout(r, 0))

    assert.deepEqual(signals.map((s) => s.url), ['https://cdn/k2'], '被取消的 k1 不该再发下载请求')
    await first.catch(() => {})
  })
})

describe('传下去的调用形式', () => {
  test('fetchBlob 拿到的是 sign 给出的 url，以及一个 AbortSignal', async () => {
    const { calls, deps } = makeDeps()
    const source = createPreviewSource(deps)

    await source.get('users/7/x.zip')

    assert.equal(calls.fetch[0].url, 'https://cdn.example/users/7/x.zip')
    assert.ok(calls.fetch[0].signal instanceof AbortSignal, 'signal 必须是真正的 AbortSignal')
  })
})

describe('失败不要留下脏缓存', () => {
  test('签名失败：错误原样抛出，下次仍会重试', async () => {
    let attempts = 0
    const source = createPreviewSource({
      sign: async () => {
        attempts += 1
        throw new Error('签名失败')
      },
      fetchBlob: async () => new Blob(['x'])
    })

    await assert.rejects(() => source.get('k'), /签名失败/)
    assert.equal(source.cachedKey(), null, '失败不该被记成缓存')
    await assert.rejects(() => source.get('k'), /签名失败/)
    assert.equal(attempts, 2, '第二次必须真的重试，而不是复用上次的失败')
  })

  test('下载失败：同样不缓存，下次重试', async () => {
    let attempts = 0
    const source = createPreviewSource({
      sign: async () => 'https://cdn/k',
      fetchBlob: async () => {
        attempts += 1
        throw new Error('下载失败')
      }
    })

    await assert.rejects(() => source.get('k'), /下载失败/)
    assert.equal(source.cachedKey(), null)
    await assert.rejects(() => source.get('k'), /下载失败/)
    assert.equal(attempts, 2)
  })

  test('cachedKey 反映当前缓存归属', async () => {
    const { deps } = makeDeps()
    const source = createPreviewSource(deps)
    assert.equal(source.cachedKey(), null)
    await source.get('k1')
    assert.equal(source.cachedKey(), 'k1')
    await source.get('k2')
    assert.equal(source.cachedKey(), 'k2')
  })
})
