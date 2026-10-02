// 自助注册的账号默认是「哑巴」—— 钉住这件事，别让人（或 AI）把它当 bug 修掉。
//
// ## 这里的默认值是设计，不是疏漏
//
// server/database/schema.sql 里 users 表有三个默认值：
//
//     maxStorage   BIGINT DEFAULT 1             ← 1 字节
//     maxDownload  BIGINT DEFAULT 1             ← 1 字节
//     expire_at    TEXT DEFAULT CURRENT_TIMESTAMP   ← 出生即过期
//
// 三个凑一起的效果：**任何自助注册的人，拿到的都是一个什么都做不了的账号。**
// 能登录，但上传（1B 装不下任何文件）、下载（1B）、任何走配额链的操作
// 全部被拒。管理员要开通，才显式给一个未来的 expire_at 与真实额度。
//
// 换句话说，「注册成功」**不等于**「能用」，中间隔着管理员这一道闸门。
// 这是防止白嫖的设计，不是需要修的缺陷。
//
// ## 曾经真的被当成 bug「修」过一次
//
// 有人把 createUser 改成显式写 expire_at = NULL，并把 schema 默认值也改成 NULL。
// 后果：每个自助注册的人都拿到一个**永不过期**的账号 —— 闸门被拆。
// （额度仍是 1B，所以拿不到大空间；但「永不过期」本身意味着这道设计失效，
//  而且任何人只要再动一次 maxStorage 的默认值就是完全开放。）
//
// 这个文件就是那次事故留下的护栏。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join('\n')
}

/**
 * 取 schema.sql 里 users 表某列的定义那一行。
 *
 * 定位用的是 `CREATE TABLE users` 而不是 `CREATE TABLE IF NOT EXISTS users` ——
 * 这个文件里写的是前者（第一版断言找 IF NOT EXISTS，三条全判「找不到列」）。
 * 后面 4000 字符足够覆盖整个 users 表（它到第 92 行的 folders 才结束）。
 */
function usersColumn(name) {
  const schema = read('server/database/schema.sql')
  const at = schema.indexOf('CREATE TABLE users')
  assert.ok(at > 0, 'schema.sql 里找不到 users 表的定义')
  const usersBlock = schema.slice(at, schema.indexOf('CREATE TABLE', at + 10))
  const line = usersBlock
    .split('\n')
    .find((l) => new RegExp(`^\\s*${name}\\s+(TEXT|BIGINT|BOOLEAN|INTEGER)`).test(l))
  return line ? line.trim() : ''
}

describe('自助注册账号的默认值：三个都不许放宽', () => {
  test('maxStorage 默认 1（1 字节）', () => {
    const line = usersColumn('maxStorage')
    assert.ok(line, 'schema 里找不到 maxStorage')
    assert.match(
      line,
      /DEFAULT\s+1\s*,?\s*$/,
      `maxStorage 的默认值必须是 1（哑巴账号），实际：${line}`
    )
    assert.doesNotMatch(
      line,
      /DEFAULT\s+0/i,
      'DEFAULT 0 = 不限 —— 那就等于给每个自助注册的人无限容量'
    )
  })

  test('maxDownload 默认 1（1 字节）', () => {
    const line = usersColumn('maxDownload')
    assert.ok(line, 'schema 里找不到 maxDownload')
    assert.match(
      line,
      /DEFAULT\s+1\s*,?\s*$/,
      `maxDownload 的默认值必须是 1，实际：${line}`
    )
    assert.doesNotMatch(line, /DEFAULT\s+0/i, 'DEFAULT 0 = 流量不限')
  })

  test('expire_at 默认 CURRENT_TIMESTAMP（出生即过期 = 等管理员开通）', () => {
    const line = usersColumn('expire_at')
    assert.ok(line, 'schema 里找不到 expire_at')
    assert.match(
      line,
      /DEFAULT\s+CURRENT_TIMESTAMP\s*,?\s*$/i,
      `expire_at 的默认值必须是 CURRENT_TIMESTAMP（出生即过期），实际：${line}`
    )
    assert.doesNotMatch(
      line,
      /DEFAULT\s+NULL/i,
      'DEFAULT NULL = 永不过期 —— 自助注册就绕过了管理员这道闸门'
    )
  })

  test('canSubAccount 默认 0（自助注册的人不能建子账户）', () => {
    // 有 parent_id 的账号额度从主账号池扣；能不能建孩子是另一道闸门。
    const schema = read('server/database/schema.sql')
    const at = schema.indexOf('CREATE TABLE users')
    const block = schema.slice(at, schema.indexOf('CREATE TABLE', at + 10))
    const line = block.split('\n').find((l) => /^\s*canSubAccount\s+BOOLEAN/.test(l))
    if (!line) {
      // 该列可能是 ALTER TABLE 加的（见 server/plugins/db-migrate.ts），那就查那里
      const migrate = read('server/plugins/db-migrate.ts')
      assert.doesNotMatch(
        migrate,
        /canSubAccount[^\n]*DEFAULT\s+1/i,
        '迁移里不能把 canSubAccount 默认设成 1'
      )
      return
    }
    assert.match(
      line,
      /DEFAULT\s+0\s*,?\s*$/,
      `canSubAccount 的默认值必须是 0，实际：${line.trim()}`
    )
  })

  test('createUser 不显式写 expire_at（让它吃到「出生即过期」的默认值）', () => {
    const dbSrc = codeOnly(read('server/utils/db.ts'))
    const start = dbSrc.indexOf('async createUser')
    assert.ok(start > 0, '没找到 createUser')
    const fn = dbSrc.slice(start, dbSrc.indexOf('\n  }', start))

    const insert = fn.slice(fn.indexOf('INSERT INTO users'))
    assert.match(insert, /INSERT INTO users/, '没找到 createUser 的 INSERT')

    // 三个危险写法都要挡住
    assert.doesNotMatch(
      insert,
      /expire_at\s*\)?\s*VALUES[^;]*NULL/i,
      'createUser 不能显式给 expire_at = NULL —— 那让自助注册的人拿到永不过期的账号'
    )
    assert.doesNotMatch(
      insert,
      /,\s*expire_at\s*(,|\))/i,
      'createUser 的列清单里不该出现 expire_at：让它吃 schema 默认值，那才是闸门'
    )
  })

  test('管理员开通时才写 expire_at（说明闸门另一侧是通的，不是死锁）', () => {
    // 反向确认：这套设计不是「永远不能用」，管理员改一下就能开通。
    // manage/updateUser.post.ts 是开通的那条路。
    const src = codeOnly(read('server/api/manage/updateUser.post.ts'))
    assert.match(
      src,
      /expire_at/,
      '管理员应该能改 expire_at 来开通账号'
    )
  })

  test('「注册成功」的提示不许承诺能用', () => {
    // 注册接口回的是「注册成功」——它描述的是**建号**成功，不是账号可用。
    // 这两件事在文案上必须分开，否则用户会以为注册完就能传文件，
    // 传不了又以为是 bug。
    const src = codeOnly(read('server/api/auth/register.post.ts'))
    assert.match(src, /statusMessage:\s*'注册成功'/)
    assert.doesNotMatch(
      src,
      /statusMessage:\s*'注册成功[^']*(可用|已开通|可以上传)/,
      '注册成功的提示不许暗示账号已经可用'
    )
  })
})
