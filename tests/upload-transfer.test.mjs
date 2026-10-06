// 上传凭证与传输方式的接线断言。
//
// ## 为什么要钉这几个
//
// 1. **STS 令牌存活时间曾经借用了 CDN 签名有效期。** 那是两个毫不相干的东西，
//    而项目默认 .env 里 CDN_AUTH_TTL=3 —— 于是每份 STS 联邦令牌都是 3 秒寿命。
//    这不是「短了点」：腾讯云 STS 对 DurationSeconds 有下限要求；即便被接受，
//    令牌在传输途中过期也会让请求失败，而传一个几 MB 的文件本身就要好几秒。
//    借配置项这种错最隐蔽的地方在于**它不报错** —— 值是合法数字，类型也对。
//
// 2. **上传一直是不分片的单发 putObject。** 单个 XHR 传完整个文件，于是：
//    中途失败没有「从第几字节续传」的概念、每次重传都是整个文件、单个请求窗口
//    长到容易撞上 net::ERR_UPLOAD_FILE_CHANGED（拖拽路径上传的是浏览器造的沙箱
//    副本，它与原文件是两套时间戳）。
//
// ## 为什么用源码断言
//
// credentials.post.ts 与 useFileUpload.ts 都碰不到真运行环境：前者依赖 Nitro
// 注入的 defineEventHandler 全局，裸 node 里 import 就 ReferenceError；后者要
// 真实 File 与 COS。所以这两处只能从源码看 —— 而且看的是**具体字面量**
// （用的是哪个配置项、字段名是什么），不是笼统的「有个分片逻辑」。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const CRED = 'server/api/upload/credentials.post.ts'
const UPLOAD = 'app/composables/useFileUpload.ts'
const CONFIG = 'nuxt.config.ts'

/** 剥注释，免得注释里出现的配置项名把判定带偏 —— 这个文件里全是注释。 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

describe('STS 令牌存活时间必须是自己的配置项', () => {
  test('DurationSeconds 用 stsTokenTtl，不再借 cdnAuthTtl', () => {
    const src = codeOnly(read(CRED))
    assert.match(
      src,
      /DurationSeconds: config\.stsTokenTtl/,
      'DurationSeconds 必须是 stsTokenTtl —— 借 cdnAuthTtl 意味着令牌寿命 = CDN 签名寿命'
    )
    assert.doesNotMatch(
      src,
      /DurationSeconds: config\.cdnAuthTtl/,
      '这条借用在 .env 的 CDN_AUTH_TTL=3 下等于发一张 3 秒就过期的通行证'
    )
  })

  // 两处必须一致：前端 useFileUpload 拿 ExpiredTime 判断令牌还有没有过期，
  // 给小了会让它在令牌其实还能用的时候提前报错。
  test('ExpiredTime 与 DurationSeconds 用同一个值', () => {
    const src = codeOnly(read(CRED))
    assert.match(
      src,
      /ExpiredTime: Math\.floor\(Date\.now\(\) \/ 1000\) \+ config\.stsTokenTtl/,
      'ExpiredTime 必须与 DurationSeconds 同源，否则前端会提前判定令牌过期'
    )
  })

  test('配置项存在，且默认值显著大于一次上传耗时', () => {
    const src = read(CONFIG)
    assert.match(
      src,
      /stsTokenTtl: parseInt\(process\.env\.STS_TOKEN_TTL \|\| '(\d+)'\)/,
      '必须真的定义 stsTokenTtl'
    )
    const def = Number(src.match(/STS_TOKEN_TTL \|\| '(\d+)'/)[1])
    assert.ok(
      def >= 900,
      `默认 ${def} 秒太小：腾讯云 STS 的 DurationSeconds 有下限，且传一个大文件本身就要更久`
    )
  })

  // 借配置项的错最容易发生在「别处也用了同一个名字」时。所以要确认
  // cdnAuthTtl 仍然只管 CDN 签名，没有被顺手改掉。
  test('cdnAuthTtl 仍然是 CDN 签名 TTL（没被一起改）', () => {
    const src = read(CONFIG)
    assert.match(src, /cdnAuthTtl: parseInt\(process\.env\.CDN_AUTH_TTL \|\| '10'\)/)
  })

  // 分片上传需要 STS 策略里有那几条 action，否则 sliceUploadFile 会在
  // InitiateMultipartUpload 就 403。这七条本来就在（为将来准备的），
  // 但从没有代码真的走到过 —— 所以要钉住「切分片时策略确实覆盖得��」。
  test('STS 策略包含分块上传所需的全部 action', () => {
    const src = codeOnly(read(CRED))
    for (const action of [
      'name/cos:PutObject',
      'name/cos:InitiateMultipartUpload',
      'name/cos:ListParts',
      'name/cos:UploadPart',
      'name/cos:CompleteMultipartUpload'
    ]) {
      assert.match(src, new RegExp(action.replace(/[/*]/g, '\\$&')), `策略缺 ${action}`)
    }
  })

  // resource 里必须带 fileKey，否则分片的每一part 都不在授权范围内
  test('resource 用 fileKey 精确到对象（分片才不会被拒）', () => {
    const src = codeOnly(read(CRED))
    assert.match(src, /resource = `qcs::cos:\$\{config\.cosRegion\}:uid\/\$\{appId\}:\$\{config\.cosBucket\}\/\$\{fileKey\}`/)
  })
})

describe('大文件走分片，小文件仍走单发', () => {
  test('按体积阈值分流', () => {
    const src = codeOnly(read(UPLOAD))
    assert.match(
      src,
      /const CHUNK_THRESHOLD = 8 \* 1024 \* 1024/,
      '必须有明确的阈值 —— 现在是无条件 putObject，等于没有分流'
    )
    assert.match(src, /const useChunks = file\.size > CHUNK_THRESHOLD/, '分流判据要落在 file.size 上')
  })

  test('分片用 sliceUploadFile，单发仍是 putObject', () => {
    const src = codeOnly(read(UPLOAD))
    assert.match(src, /cos\.sliceUploadFile\(\{/, '大文件必须走 sliceUploadFile')
    assert.match(src, /cos\.putObject\(\{/, '小文件保留 putObject —— 分片的额外往返对小文件不划算')
    // 两个分支的顺序：先判 useChunks 再 putObject，且 putObject 在 else 位置
    const chunkAt = src.indexOf('cos.sliceUploadFile({')
    const putAt = src.indexOf('cos.putObject({')
    assert.ok(chunkAt > 0 && putAt > 0)
    assert.ok(chunkAt < putAt, 'sliceUploadFile 分支要写在前面')
  })

  // 我第一版写的是 SliceSize，TS 报了「未知属性」。这个字段名错了不会有任何
  // 运行时症状吗？会 —— SDK 忽略未知字段，退回默认 1MB 分片，静默多出 N 倍请求。
  // 所以字段名本身要钉住。
  test('分块大小字段名是 ChunkSize（不是 SliceSize）', () => {
    const src = codeOnly(read(UPLOAD))
    assert.match(
      src,
      /ChunkSize: 4 \* 1024 \* 1024/,
      '字段名必须是 ChunkSize —— SliceSize 是 uploadFiles 的参数名，SDK 会静默忽略它并退回 1MB'
    )
    const chunkAt = src.indexOf('cos.sliceUploadFile({')
    const block = src.slice(chunkAt, src.indexOf('}, onDone)', chunkAt))
    assert.doesNotMatch(block, /SliceSize/, 'sliceUploadFile 的参数里不该出现 SliceSize')
  })

  // COS 要求分片 ≥ 1MB
  test('分块不小于 COS 的 1MB 下限', () => {
    const src = codeOnly(read(UPLOAD))
    const m = src.match(/ChunkSize: ([\d* ]+)/)
    assert.ok(m, '没找到 ChunkSize')
    const bytes = eval(m[1].trim()) // 形如 4 * 1024 * 1024
    assert.ok(bytes >= 1024 * 1024, `分块 ${bytes} 字节小于 COS 的 1MB 下限`)
  })

  // 两个分支共用同一套进度与收尾。分成两份的话，进度条会在分片分支上不更新，
  // 而错误处理也会分叉。
  test('两个分支共用 onProgress / onDone（进度与错误不重复实现）', () => {
    const src = codeOnly(read(UPLOAD))
    const chunkAt = src.indexOf('cos.sliceUploadFile({')
    const putAt = src.indexOf('cos.putObject({')
    assert.ok(chunkAt > 0 && putAt > 0)
    assert.ok(chunkAt < putAt, 'sliceUploadFile 分支要写在前面')
    // 两个调用点后面跟的都是 onDone，且 onProgress/onDone 只各定义一次
    assert.match(src.slice(chunkAt, chunkAt + 400), /\}, onDone\)/, '分片分支要接 onDone')
    assert.match(src.slice(putAt, putAt + 400), /\}, onDone\)/, '单发分支要接同一个 onDone')
    assert.equal(
      [...codeOnly(src).matchAll(/const onDone = /g)].length,
      1,
      'onDone 只该定义一次 —— 两份实现就意味着错误处理分叉'
    )
    assert.equal([...codeOnly(src).matchAll(/const onProgress = /g)].length, 1, 'onProgress 只该定义一次')
  })

  // 进度必须真的被喂出去。onProgress 是两个分支共用的，所以它坏掉时**两条路都**
// 没有进度条 —— 而且不报错，只是进度永远停在 0。这类「静默失效」只能靠
// 断言守住，读代码容易看漏（回调里三行，取值都在）。
  test('onProgress 真的驱动了进度（回调体不是空的）', () => {
    const src = codeOnly(read(UPLOAD))
    const at = src.indexOf('const onProgress =')
    assert.ok(at > 0, '没找到 onProgress')
    const body = src.slice(at, src.indexOf('const onDone =', at))
    // lastLoaded 声明在外层（与 onProgress 同级，但不在回调体内），
    // 所以取值范围要从 promise 那一层开始 —— 第一版从 onProgress 切，
    // 于是 `let lastLoaded` 落在外面，被误判成「回调里没有」。
    const scopeAt = src.indexOf('const CHUNK_THRESHOLD')
    const scope = src.slice(scopeAt, src.indexOf('const onDone =', at))
    // 单文件上传：setProgress 让页面上的进度条走
    assert.match(
      body,
      /if \(!partOfBatch\) setProgress\(loaded, total\)/,
      '单文件上传必须更新进度条 —— 少了它进度永远停在 0 且不报错'
    )
    // 批量上传：onProgressDelta 把增量交给外层聚合
    assert.match(
      body,
      /options2\?\.onProgressDelta\?\.\(delta\)/,
      '批量上传必须把增量喂给外层聚合 —— 少了它多文件进度永远不动'
    )
    // 增量算法：先取 loaded，再与上次比对（顺序反了 delta 恒为 0）
    // 顺序判断必须在**同一个字符串**上做位置比较。
    // 第一版拿 body 的下标去比 scope 的下标（scope 是 body 的前缀切片，
    // 起点不同），于是 deltaAt 恒「小于」lastLoadedAt —— 断言变成恒假，
    // 正确实现也判不过。
    const loadedAt = scope.indexOf('const loaded =')
    const lastLoadedAt = scope.indexOf('let lastLoaded')
    const deltaAt = scope.indexOf('const delta =')
    const assignAt = scope.indexOf('lastLoaded = loaded')
    assert.ok(loadedAt > 0, '回调里要有 loaded')
    assert.ok(lastLoadedAt >= 0, '外层要有 lastLoaded —— 没有它就没有增量可算')
    assert.ok(lastLoadedAt < loadedAt, 'lastLoaded 要先声明')
    assert.ok(deltaAt > loadedAt, 'delta 必须在 loaded 之后算')
    assert.ok(deltaAt > lastLoadedAt, 'delta 必须在 lastLoaded 之后算（要用它的旧值）')
    assert.ok(assignAt > deltaAt, 'lastLoaded 要在 delta 之后更新，否则 delta 恒为 0')
  })

  // SDK 传进来的 progressData 不保证非空（不同版本 / 不同调用点可能不给），
  // 所以取值必须带 ?. 与 ?? 兜底。少了?. 时症状是「某个 SDK 版本下整个上传
  // 回调抛异常」—— 而抛在回调里往往只表现成进度条不动，很难定位到这一行。
  test('取值带 ?. 与 ?? 兜底（SDK 不保证传了参数）', () => {
    const src = codeOnly(read(UPLOAD))
    const at = src.indexOf('const onProgress =')
    const body = src.slice(at, src.indexOf('const onDone =', at))
    assert.match(
      body,
      /progressData\?\.loaded \?\? 0/,
      'loaded 必须兜底 —— SDK 可能不给参数，那时 ?. 少了就是 TypeError'
    )
    assert.match(
      body,
      /progressData\?\.total \?\? file\.size/,
      'total 必须兜底到 file.size'
    )
  })
})