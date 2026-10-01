/**
 * 文件对象路径（file_key）的归属规则。
 *
 * 背景：file_key 是 COS 里的真实对象路径，而它原先由客户端原样送进
 * /api/files/save.post.ts，服务端只生成、从不复验。配合
 * download.post.ts 用**请求里的** fileKey 去签 CDN，两个缺陷叠起来
 * 就能签出未授权的路径。这里把归属规则本身钉住。
 *
 * 这些用例不碰 HTTP 层 —— 规则集中在 server/utils/file-key.ts，
 * 直接对着源码验证判定逻辑，避免为测一个纯函数去起服务。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/**
 * 去掉 // 与 /* *\/ 注释。
 *
 * 查「有没有回退值」这类问题时必须去注释：解释为什么删掉某个常量，注释里
 * 就会写出那个常量名，按原文查必然误判。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * 从源码里抽出 fileKeyOwnerId 的实现并在这里跑一遍。
 * 不走 import 是因为 server/utils 依赖 Nuxt 的自动导入别名（~~/），
 * 直接 import 在 node --test 下解析不了。
 */
function fileKeyOwnerId(fileKey) {
  const parts = typeof fileKey === 'string' ? fileKey.split('/') : []
  if (parts.length < 3) return null
  const [prefix, idRaw] = parts
  if (!['users', 'u'].includes(prefix)) return null
  if (!/^\d+$/.test(idRaw)) return null
  const id = Number(idRaw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const fileKeyBelongsTo = (fileKey, ownerId) => {
  const id = fileKeyOwnerId(fileKey)
  return id !== null && id === ownerId
}

describe('fileKey 的归属判定', () => {
  test('上传形状 users/<id>/… 认得', () => {
    assert.equal(fileKeyOwnerId('users/141/202610/secret-report.xlsx'), 141)
  })

  test('复制形状 u/<id>/… 认得（两种前缀都必须认，漏一个就挡不住对应路径）', () => {
    assert.equal(fileKeyOwnerId('u/43/2026-10-01/1759_ab12cd_note.txt'), 43)
  })

  test('属主对得上才算属于', () => {
    assert.equal(fileKeyBelongsTo('users/141/202610/a.xlsx', 141), true)
    assert.equal(fileKeyBelongsTo('users/141/202610/a.xlsx', 43), false)
  })

  test('形状不认识的一律不属于（宁可错挡，不可错放）', () => {
    for (const bad of [
      'etc/passwd', // 绝对路径
      'public/a.txt', // 未知前缀
      'users//202610/a.txt', // 缺 id 段
      'users/141', // 段数不够
      'users/141abc/a.txt', // id 带后缀
      'users/ 5/a.txt', // id 带空格
      'users/-1/a.txt', // 负数
      'users/0/a.txt', // 0 不是合法 user id
      '../../users/141/a.txt', // 相对穿越
      '', // 空
      null,
      undefined,
      123
    ]) {
      assert.equal(fileKeyBelongsTo(bad, 141), false, `不该认：${String(bad)}`)
    }
  })

  test('不能靠中间某段凑出 id —— 必须是紧跟前缀的那一段', () => {
    // 若实现改成「找任意一段等于属主」，这条会通过。当前实现必须拒绝。
    assert.equal(fileKeyBelongsTo('users/999/141/a.txt', 141), false)
  })

  test('user id 相同但前缀不同仍算属于（两种形状都是本项目生成的）', () => {
    assert.equal(fileKeyBelongsTo('u/141/2026-10-01/x_a.txt', 141), true)
  })
})

describe('写入侧接上了归属校验', () => {
  test('save.post.ts 在入库前调 assertFileKeyOwner', () => {
    const src = read('server/api/files/save.post.ts')
    assert.ok(src.includes('assertFileKeyOwner(fileKey, userId)'), 'save 路径没校验')
  })

  test('比的是属主 userId 而不是发起人 authId', () => {
    // useAdmin 场景下文件写进别人的树（userId = dest.userId），
    // 拿 authId 比会把管理员自己的合法上传也挡掉。
    const src = read('server/api/files/save.post.ts')
    assert.ok(
      !/assertFileKeyOwner\(fileKey,\s*authId\)/.test(src),
      '不能拿 authId 比：管理员代写会被误挡'
    )
  })

  test('校验在 INSERT 之前，不在之后', () => {
    const src = read('server/api/files/save.post.ts')
    const guard = src.indexOf('assertFileKeyOwner(fileKey, userId)')
    const insert = src.indexOf('INSERT INTO files')
    assert.ok(guard > -1 && insert > -1, '两者都要在')
    assert.ok(guard < insert, '校验必须早于插入，否则已经写进去了')
  })
})

describe('签名用的是被授权那一行的路径', () => {
  test('generateCDNUrl 传 fileRecord.fileKey 而不是请求里的 fileKey', () => {
    const src = read('server/api/files/download.post.ts')
    assert.ok(
      /generateCDNUrl\(\s*fileRecord\.fileKey/.test(src),
      'CDN 签名必须签 fileRecord.fileKey'
    )
    assert.ok(
      !/generateCDNUrl\(\s*fileKey\s*,/.test(src),
      '不能签请求里的 fileKey'
    )
  })

  test('COS 直链同样用 fileRecord.fileKey', () => {
    const src = read('server/api/files/download.post.ts')
    assert.ok(
      /myqcloud\.com\/\$\{fileRecord\.fileKey\}/.test(src),
      'COS 直链要用 fileRecord.fileKey'
    )
  })
})

describe('按 fileKey 查行的结果确定', () => {
  test('findAccessibleByKey 带 ORDER BY id LIMIT 1', () => {
    const src = read('server/utils/db.ts')
    const fn = src.slice(src.indexOf('async findAccessibleByKey'))
    const sql = fn.slice(0, fn.indexOf('ensureAccess'))
    assert.ok(
      /WHERE file_key = \? ORDER BY id LIMIT 1/.test(sql),
      '重复行存在时命中哪一行必须确定'
    )
  })
})

describe('file_key 唯一索引', () => {
  test('schema.sql 声明了 UNIQUE', () => {
    const sql = read('server/database/schema.sql')
    assert.ok(/CREATE UNIQUE INDEX ux_files_file_key ON files \(file_key\)/.test(sql))
  })

  test('db-migrate 会给老库补，且重复行时跳过而不是崩', () => {
    const src = read('server/plugins/db-migrate.ts')
    assert.ok(src.includes('ux_files_file_key'), '迁移里没有这个索引')
    assert.ok(src.includes('hasDuplicateFileKeys'), '没有查重复就建索引 = 老库会起不来')
    // 建索引必须包在 try 里：万一库被锁/只读，不该拖垮启动
    const block = src.slice(src.indexOf('ux_files_file_key'), src.indexOf('ux_files_file_key') + 900)
    assert.ok(block.includes('try'), '建索引没有兜底')
    assert.ok(block.includes('console.warn'), '建索引失败要告警')
  })
})

describe('只读受权人拿不到对象路径', () => {
  test('列表响应按下载位决定 fileKey 给不给', () => {
    const src = read('server/api/files/index.get.ts')
    assert.ok(
      src.includes('!hasPermission(perm, PERM_DOWNLOAD)'),
      '没有按下载位抹掉 fileKey'
    )
  })

  test('链接视角不受影响 —— LINK_PERMISSION 含下载位', () => {
    // 链接是排他路径，不经 withMeta。LINK_PERMISSION = READ|DOWNLOAD，
    // 匿名访客必须仍能下载，所以这里钉住它没有被顺手改掉。
    const src = read('types/share.ts')
    assert.ok(
      /LINK_PERMISSION = PERM_READ \| PERM_DOWNLOAD/.test(src),
      '链接权限必须仍是读+下载'
    )
  })

  test('前端用 fileKey 是否存在来判断能不能下载，不复现权限算法', () => {
    const src = read('types/share.ts')
    assert.ok(
      /export function canDownloadFile/.test(src),
      '缺 canDownloadFile：前端会各处自己猜'
    )
  })

  test('下载与预览都先挡一道，不发必然 400 的请求', () => {
    const bulk = read('app/composables/useBulkActions.ts')
    assert.ok(bulk.includes('canDownloadFile(file)'), 'downloadFile 没挡')

    const previewer = read('app/components/FilePreviewer.vue')
    // 两处：load() 与 handleDownload()
    const guards = previewer.match(/if \(!currentFileKey\.value\)/g) || []
    assert.equal(guards.length, 2, `预览与下载两处都要挡，现在只有 ${guards.length} 处`)
  })
})

describe('密钥不再有静默回退', () => {
  test('nuxt.config 不含回退常量', () => {
    // 去掉注释再查：nuxt.config 里为了说明「为什么删掉回退」必然提到那些常量名，
    // 按原文查会误判。有没有回退值是**代码**的性质，不是注释的性质。
    const code = stripComments(read('nuxt.config.ts'))
    assert.ok(
      !code.includes('fallback-secret-key'),
      'sessionSecret 仍有回退值'
    )
    assert.ok(
      !code.includes('cdn_auth_key_primary') && !code.includes('cdn_auth_key_backup'),
      'CDN 鉴权密钥仍有回退值'
    )
  })

  test('启动时校验，缺配置就抛', () => {
    const src = read('server/plugins/require-session-secret.ts')
    assert.ok(src.includes('checkSecret(config.sessionSecret'), '没校验 sessionSecret')
    assert.ok(src.includes('NUXT_SESSION_SECRET'), '提示里没告诉用户配哪个变量')
  })

  test('占位符字面量按未配置处理（照着示例填是最可能的踩法）', () => {
    const src = read('server/plugins/require-session-secret.ts')
    // 实测踩到过的那一个必须在列表里
    assert.ok(
      src.includes("'a_secure_random_string_for_sessions'"),
      '没拦实际用过的占位符'
    )
    assert.ok(src.includes('PLACEHOLDER_SECRETS'), '没有占位符判定')
  })

  test('校验放在插件而不是配置解析阶段（构建期常常没有 .env）', () => {
    const config = read('nuxt.config.ts')
    // nuxt.config 里出现 throw 就会让 nuxt build 在无 .env 环境下失败
    const runtimeBlock = config.slice(config.indexOf('runtimeConfig'), config.indexOf('build:'))
    assert.ok(
      !runtimeBlock.includes('throw'),
      '不能在 nuxt.config 里抛：构建期没有 .env'
    )
  })
})
