// 配额链的「接线覆盖」测试。
//
// ## 为什么这份测试是单独一份
//
// sub-account-quota.test.mjs 把 reserveStorage / poolUsage 这些**引擎**测得很透
// （67 例 + 17 条变异），但引擎正确不等于有人用它。
//
// 实际漏掉的 bug 就是这么来的：server/api/upload/credentials.post.ts 自己写了一句
// `if (maxStorage > 0 && usedForCheck + size > maxStorage)` 当闸门，完全没有 import
// sub-account。而子账户建号时 maxStorage 故意给 0（不限），于是 `maxStorage > 0`
// 恒为 false —— **这层闸门对子账户等于不存在**。凭证照发，文件真进了 COS，
// /api/files/save 的 reserveStorage 才失败，数据库没记录 → 孤儿对象。
//
// 这类 bug 在结构上**不可能**被引擎测试抓到：被测的引擎没问题，坏的是接线。
// 所以这份测试扫的是 server/api/，断言「谁在把关，谁就必须接线」。
//
// ## 为什么要把清单打进输出
//
// 穷举过一次就够了 —— 但「穷举过一次」这件事得留下痕迹。下次新增一个碰配额的
// 接口，测试输出里会多出一行，提醒你它也得走链。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.ts')) yield p
  }
}

const API_FILES = [...walk(join(root, 'server/api'))].map((p) => relative(root, p)).sort()

/** 去掉注释，免得注释里提到的常量把判定带偏 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join('\n')
}

/**
 * 判定「这个文件是不是自己当配额闸门」。
 *
 * 特征是**拿额度字段做比较来决定放行与否**，只有三种出现方式：
 *   - `maxStorage > 0` / `maxDownload > 0` 这类守卫
 *   - `... + size > maxStorage` / `> maxDownload` 这类算式
 *   - 直接调 reserveStorage / reserveDownload
 *
 * 刻意**不算**「只是读写额度字段」的：建号（accounts/index.post.ts）、改额度
 * （accounts/quota.post.ts、manage/updateUser.post.ts）、列表（listUsers.get.ts、
 * accounts/index.get.ts）本来就不该走链 —— 它们是配额的主人，不是配额的门卫。
 */
function isQuotaGate(src) {
  const code = codeOnly(src)
  return [
    /\b(?:maxStorage|maxDownload)\s*>\s*0\b/,
    /\+\s*(?:\w+\.)?size\s*>\s*(?:\w+\.)?max(?:Storage|Download)\b/,
    /\+\s*\w+\s*>\s*(?:\w+\.)?max(?:Storage|Download)\b/,
    // reserve* 是预占，precheck* 是预检 —— 两者都是闸门。
    // 第一版只写了 reserve*，结果 folders/manifest.get.ts（走 precheckDownload）
    // 没被认成闸门，测试直接漏掉了它 —— 与当初漏掉 credentials 一模一样的错。
    /\breserve(?:Storage|Download)\s*\(/,
    /\bprecheck(?:Storage|Download)\s*\(/
  ].some((re) => re.test(code))
}

const inventory = API_FILES.map((f) => {
  const src = read(f)
  return {
    file: f,
    gate: isQuotaGate(src),
    chained: /server\/utils\/sub-account/.test(codeOnly(src))
  }
})

describe('配额闸门的接线覆盖', () => {
  test('扫出来的清单（新增碰配额的接口会在这里多出一行）', () => {
    console.log('\n  server/api/ 下与配额有关的接口：')
    for (const row of inventory.filter((r) => r.gate)) {
      console.log(`    ${row.chained ? '✓' : '✗'} ${row.file}`)
    }
    console.log('  （其余接口只是读写额度字段，不当闸门，不在此列）\n')
    assert.ok(inventory.some((r) => r.gate), '一个闸门都没扫到 —— 判定规则坏了')
  })

  test('每个自己当闸门的接口都必须 import 配额链', () => {
    // 这就是当初漏掉 upload/credentials.post.ts 的那条断言
    const offenders = inventory.filter((r) => r.gate && !r.chained).map((r) => r.file)
    assert.deepEqual(
      offenders,
      [],
      '这些接口自己拿额度字段当闸门，却没接 server/utils/sub-account：\n' +
        offenders.join('\n') +
        '\n\n后果：子账户的 maxStorage 默认 0（不限），`maxStorage > 0` 恒为 false，' +
        '这层闸门对子账户等于不存在 —— 凭证照发、文件真进 COS，' +
        '直到 /api/files/save 的 reserveStorage 才失败，数据库却没记录。'
    )
  })

  test('配额链的三个真实闸门都接上了（防止有人把接线删掉）', () => {
    // 反向钉住：确认这个扫描确实覆盖到了已知的正确实现，
    // 否则「全部通过」可能只是因为扫描没匹配到任何东西。
    for (const f of [
      'server/api/files/save.post.ts',
      'server/api/files/download.post.ts',
      'server/api/copy/paste.post.ts',
      'server/api/folders/manifest.get.ts',
      'server/api/upload/credentials.post.ts'
    ]) {
      const row = inventory.find((r) => r.file === f)
      assert.ok(row, f + ' 不在清单里 —— 扫描漏文件了')
      assert.ok(row.gate, f + ' 没被识别成配额闸门 —— 判定规则漏了这个形态')
      assert.ok(row.chained, f + ' 没有 import 配额链')
    }
  })

  test('只是读写额度字段的接口不该被误判成闸门', () => {
    // 反向误报检查：这些是配额的主人（建号/改额度/列表），不该走链。
    // 判定规则一旦过宽，这里就会红。
    for (const f of [
      'server/api/accounts/index.post.ts',
      'server/api/accounts/quota.post.ts',
      'server/api/manage/updateUser.post.ts',
      'server/api/manage/listUsers.get.ts'
    ]) {
      const row = inventory.find((r) => r.file === f)
      assert.ok(row, f + ' 不在清单里')
      assert.ok(!row.gate, f + ' 被误判成配额闸门了 —— 它只是读写额度字段')
    }
  })
})

describe('credentials.post.ts 的闸门细节（只能源码断言）', () => {
  // ## 为什么这一节是源码断言而不是行为测试
  //
  // handler 用 Nuxt 的自动导入（defineEventHandler / readBody / createError），
  // 在 `node --test` 里 import 不了 —— 这是本项目的既有天花板（见
  // tests/sub-accounts.test.mjs 里同样的处理）。所以这里只能断言「写法」。
  //
  // **这是真的覆盖缺口**：如果有人把 `if (pre.fail)` 改成 `if (false)`，
  // 下面这些断言抓不到，得靠运行时才发现。能做的都做了，把缺口写在这儿，
  // 而不是假装测到了。
  const CRED = 'server/api/upload/credentials.post.ts'

  test('拿到 precheckStorage 的 fail 就必须拦住', () => {
    const code = codeOnly(read(CRED))
    assert.match(
      code,
      /if \(pre\.fail\) \{[\s\S]{0,300}?throw createError\(/,
      'precheckStorage 给出原因时必须抛错。' +
        '注意判据是 `pre.fail` 而不是 `!pre.allowed`：allowed 与 fail 是两个独立字段，' +
        'TS 不会因为 allowed 为假就认为 fail 非空，而 fail 才是真正的判别式'
    )
    assert.match(code, /statusCode:\s*403/, '拦住时必须是 403')
    assert.match(
      code,
      /quotaFailMessage\(db, pre\.fail/,
      '文案要走 quotaFailMessage —— 它按 self/parent 分流，' +
        '直接写死一句话会让用户分不清该调自己还是调主账号'
    )
  })

  test('覆盖上传时 delta 必须是「新减旧」，与 save.post.ts 同形', () => {
    // 两边不一致的后果：这里放行（预检够）而 save 拒绝（预占不够），
    // 或者反过来放行一个注定失败的请求。用户看到的都是「能传但传不上去」。
    const code = codeOnly(read(CRED))
    assert.match(
      code,
      /delta = size - Number\(row\.fileSize \?\? 0\)/,
      '覆盖时 delta 应为 新大小 - 旧大小（可为负 = 释放空间）'
    )
    assert.match(code, /let delta = size/, '新建时 delta 就是整个文件大小')

    // 反向确认 save.post.ts 收到的是同一个形状
    const save = codeOnly(read('server/api/files/save.post.ts'))
    assert.match(
      save,
      /const delta = size - oldSize/,
      'save.post.ts 也应该用 新减旧；两边不一致就是分叉'
    )
  })

  test('skipIfExist 命中已有文件时直接返回，不进入配额判定', () => {
    // 顺序不能反：先说「已存在、跳过」，再谈配额。
    // 反过来的话，用户在配额已满时覆盖一个同名文件会看到「存储不足」
    // 而不是「已跳过」。
    const code = codeOnly(read(CRED))
    // 找**调用处**而不是 import 处：`indexOf('precheckStorage')` 会先命中文件顶部
    // 那行 import（它在所有逻辑之前），于是 skipAt < preAt 永远成立，断言恒真。
    // 第一版就是这么写的，测试直接红了 —— 断言写错，不是实现错。
    const skipAt = code.indexOf('skipIfExist === true')
    const preAt = code.indexOf('precheckStorage(db')
    assert.ok(skipAt > 0, '没找到 skipIfExist 分支')
    assert.ok(preAt > 0, '没找到 precheckStorage 的调用')
    assert.ok(skipAt < preAt, `skipIfExist 应在配额预检之前（skipAt=${skipAt}, preAt=${preAt}）`)
  })
})

describe('上传失败只提示一次', () => {
  // 同一个 error 对象被 uploadMultipleFiles 抛给 handleFiles，两层各调一次
  // notifyError → 屏幕上同一句话出现两遍（fallback 不生效，因为 403 自带 message，
  // 所以两遍显示的正是同一句「存储空间不足，上传该文件将超出配额」）。
  //
  // ## 第一版这条断言写错了
  //
  // 我最初数的是「这两个文件里 notifyError 一共出现几次」，得到 5，直接判红。
  // 5 是对的 —— useDnDUpload 里另外两处（创建目录失败、文件夹内文件上传失败）
  // 是**另外的错误路径**，跟上传失败这条链无关，不该算进来。
  //
  // 真正要抓的不变量是：**在 uploadMultipleFiles → handleFiles 这一条链上，
  // 只有终点报一次**。内层 uploadMultipleFiles 只负责把错误传上去。
  const UP = codeOnly(read('app/composables/useFileUpload.ts'))
  const DND = codeOnly(read('app/composables/useDnDUpload.ts'))

  /** 取出某个具名函数的源码（从 `const <name> = ` 或 `function <name>` 到下一个顶层声明） */
  function bodyOf(code, name) {
    const start = code.search(new RegExp(`(const\\s+${name}\\s*=|function\\s+${name}\\b|async function ${name}\\b)`))
    if (start < 0) return ''
    // 往后找到下一个顶层 `const xxx =` / `function xxx` 为止
    const rest = code.slice(start + 1)
    const next = rest.search(/\n(?:const|function|async function)\s+\w/)
    return next < 0 ? rest : rest.slice(0, next)
  }

  test('uploadMultipleFiles 不弹 toast，只把错误抛上去', () => {
    // 它永远跑在 useDnDUpload 的 handleFiles / handleEntries 里，那才是报错的终点。
    // 它自己再弹一次，就是同一个错误弹两遍。
    const body = bodyOf(UP, 'uploadMultipleFiles')
    assert.ok(body, '没找到 uploadMultipleFiles —— 改名了？')
    assert.doesNotMatch(
      body,
      /\bnotifyError\s*\(/,
      'uploadMultipleFiles 的 catch 里不该调 notifyError：' +
        '它把错误原样 throw 给 handleFiles / handleEntries，由那一层弹。' +
        '两层都弹 = 同一句提示出现两遍。' +
        '\n（uploadError.value 那行留着 —— 那是页面内的横幅，不是 toast，重复赋值无害）'
    )
  })

  test('但它仍要把错误抛上去（不能顺手吞掉）', () => {
    const body = bodyOf(UP, 'uploadMultipleFiles')
    assert.match(
      body,
      /catch[\s\S]*?\bthrow\b/,
      'uploadMultipleFiles 必须把错误继续抛出去，否则外层永远等不到失败'
    )
    assert.match(body, /uploadError\.value\s*=/, '横幅还是要设，外层看不到 uploadError')
  })

  test('终点 handleFiles 仍然弹 toast（防止把两处一起删了变成静默失败）', () => {
    const body = bodyOf(DND, 'handleFiles')
    assert.ok(body, '没找到 handleFiles')
    assert.match(
      body,
      /\bnotifyError\s*\(/,
      'handleFiles 是这条链的终点，它不弹就没人提示了 —— 那比弹两遍更糟'
    )
  })

  test('uploadFile 的单文件路径仍自己弹（FilePreviewer 存文本用，没有外层）', () => {
    const body = bodyOf(UP, 'uploadFile')
    assert.ok(body, '没找到 uploadFile')
    assert.match(
      body,
      /if\s*\(\s*!partOfBatch\s*\)[\s\S]{0,120}?notifyError\s*\(/,
      'uploadFile 非批量时要自己弹 —— FilePreviewer 调它时外面没有 catch'
    )
  })

  test('异常是逐层原样重抛的（所以每层拿到的都是同一个 error 对象）', () => {
    // 这是重复提示成立的前提：没有包装成「已提示过」的形态。
    for (const [f, code] of [['useFileUpload.ts', UP], ['useDnDUpload.ts', DND]]) {
      const throws = code.split('\n').filter((l) => /^\s*throw\s+\w+\s*$/.test(l))
      for (const t of throws) {
        assert.match(
          t,
          /throw\s+error\b|throw\s+e\b/,
          f + ' 里有包装过再抛的写法，那会改变错误对象：' + t.trim()
        )
      }
    }
  })

  test('uploadError（红条横幅）与 notifyError 是两回事：横幅允许多层赋值', () => {
    // 横幅是页面内的一行状态，重复赋同一个值看不出问题；
    // toast 是弹给用户的，重复弹就是 bug。所以只约束后者。
    const banner = UP.split('\n').filter((l) => /uploadError\.value\s*=/.test(l))
    console.log(`  uploadError.value 赋值 ${banner.length} 处（横幅，允许多层）`)
    assert.ok(banner.length >= 1, '上传失败时总得让横幅显示点什么')
  })
})
