// FileList.vue 的分享角标：**目录行和文件行必须有同一个角标**。
//
// ## 这是什么缺陷
//
// 三个角标里，link 标（左上角）和红点（右下角）目录、文件都有，
// 分享角标（右上角 lock / users / share）**只有目录行有**。文件行只剩
// 一个孤零零的红点。
//
// 后果是界面上自相矛盾：「你设置的分享当前没生效」的红点亮着，
// 却不告诉你分享的是什么状态；而 Shared=0（不分享）这种最该警示的
// 状态，文件行完全无声 —— 点开分享弹窗才知道。
//
// ## 为什么断言必须作用于「同一个角标」
//
// 这类不一致最容易被无声改回去：有人觉得文件图标小、角标挤，就从文件行
// 删掉这一段，界面立刻「整齐」了，没有任何测试会红。所以这里的断言不是
// 「文件行里有 resolveShareBadge」这种存在性检查，而是**逐字符比对两段
// markup** —— 少一个图标、颜色改了、title 掉了、门控条件不一样，都会红。
//
// ## 覆盖不到的部分
//
// 本项目没有 @vue/test-utils / happy-dom，组件挂载后渲染不了。所以
// 「badgeOf 真的被调用了」「badges map 真的算对了」这类运行时行为测不到，
// 只能断言模板结构与 script 的接线方式。
//
// 而**位置好不好看**（白底角标叠在 FileIcon 上是否跳得出来 —— FileIcon
// 按扩展名分色、深浅不一，黄色实心文件夹上是白底就够，浅色图标上不一定），
// 最终仍需浏览器里看一眼。这不是这份测试能替代的。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const LIST = 'app/components/FileList.vue'
const TYPES = 'types/file-list.ts'
const DB = 'server/utils/db.ts'

/** 去掉注释，免得注释里提到的东西把判定带偏 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

/**
 * 取顶层 <template>。
 *
 * 不能用 `/<template>([\s\S]*?)<\/template>/` —— 非贪婪会在第一个
 * `</template>` 处停下，而文件行里没有嵌套 template，目录行里也没有，
 * 但这个坑在 ArchiveBrowser 上踩过（面包屑用了 `<template v-for>`）。
 * 交给 @vue/compiler-sfc，它知道嵌套层级。
 */
function templateOf(src) {
  const { descriptor, errors } = parse(src, { filename: 'x.vue' })
  assert.equal(errors?.length ?? 0, 0, 'SFC 解析出错 —— 测试的输入本身有问题')
  return codeOnly(descriptor.template?.content ?? '')
}

/**
 * 定位「那个分享角标的 <span>」整段。
 *
 * 从 `badges.get(badgeKey(kind, ...))` 往前找最近的 `<span`（起点），
 * 再按 `<span` / `</span>` 配平到终点。角标 span 里只有图标、没有嵌套
 * span，配平就是数这两个标签。
 *
 * 为什么不能靠「从上往下找第一个带 LockClosedIcon 的 span」：那会同时
 * 命中图标自己（`<LockClosedIcon ...>`），而且分不清是目录行还是文件行。
 */
function badgeSpan(tpl, kind, idExpr) {
  const at = tpl.indexOf(`badges.get(badgeKey('${kind}', ${idExpr}))`)
  assert.ok(at > 0, `模板里找不到 ${kind} 行的角标（${kind} 行没有分享角标？）`)

  const start = tpl.lastIndexOf('<span', at)
  assert.ok(start > 0 && start < at, '没找到角标的 <span> 起点')

  let depth = 0
  let end = -1
  for (let i = start; i < tpl.length; i++) {
    if (tpl.startsWith('<span', i)) depth++
    else if (tpl.startsWith('</span>', i)) {
      depth--
      if (depth === 0) {
        end = i + '</span>'.length
        break
      }
    }
  }
  assert.ok(end > 0, '角标 <span> 没配平 —— 测试的输入本身有问题')
  return tpl.slice(start, end)
}

/**
 * 归一化后比对：抹掉 id 表达式与缩进。
 *
 * 目录行缩进比文件行深两格（它嵌在 checkbox 之后的 div 里），不归一化
 * 就只能逐字节相同，而那会把「为了对齐而重排」误报成不一致。
 */
function normalizeBadge(block, idExpr) {
  return block
    .replace(new RegExp(`badgeKey\\('(folder|file)', ${idExpr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g'), 'KEY')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
}

describe('分享角标：目录行与文件行必须是同一个', () => {
  test('两段 markup 逐字符一致（少图标 / 改颜色 / 掉 title 都会红）', () => {
    const tpl = templateOf(read(LIST))
    const folder = normalizeBadge(badgeSpan(tpl, 'folder', 'folder.id'), 'folder.id')
    const file = normalizeBadge(badgeSpan(tpl, 'file', 'file.id'), 'file.id')

    assert.equal(
      file,
      folder,
      '文件行的分享角标与目录行不一致。\n' +
        '--- 目录行 ---\n' + folder + '\n--- 文件行 ---\n' + file
    )
  })

  test('两行都由 showShareBadge 门控（共享清单视角下都不显示）', () => {
    const tpl = templateOf(read(LIST))
    for (const [kind, idExpr] of [['folder', 'folder.id'], ['file', 'file.id']]) {
      const block = badgeSpan(tpl, kind, idExpr)
      assert.match(
        block,
        /v-if="showShareBadge &&/,
        `${kind} 行的角标没有 showShareBadge 门控 —— 共享清单里那些是别人的内容，` +
          '角标显示出来会误导（link 标与红点都用这个开关门控）'
      )
    }
  })

  test('三态三种颜色都在（lock 红 / users 绿 / share 蓝）', () => {
    const tpl = templateOf(read(LIST))
    for (const [kind, idExpr] of [['folder', 'folder.id'], ['file', 'file.id']]) {
      const block = badgeSpan(tpl, kind, idExpr)
      for (const [icon, color, badge] of [
        ['LockClosedIcon', 'text-red-500', 'lock'],
        ['UsersIcon', 'text-emerald-500', 'users'],
        ['ShareIcon', 'text-blue-500', 'share']
      ]) {
        assert.match(
          block,
          new RegExp(`<${icon}[^>]*${color}`),
          `${kind} 行少了 ${badge} 的图标或颜色`
        )
      }
    }
  })

  // 只有 badge 值，没有文案，鼠标悬停就什么都不说。
  test('角标带 title 与 aria-label（与 SHARE_BADGE_LABELS 同源）', () => {
    const tpl = templateOf(read(LIST))
    for (const [kind, idExpr] of [['folder', 'folder.id'], ['file', 'file.id']]) {
      const block = badgeSpan(tpl, kind, idExpr)
      assert.match(block, /:title="badgeTitle\(/, `${kind} 行角标没有 title`)
      assert.match(block, /:aria-label="badgeTitle\(/, `${kind} 行角标没有 aria-label`)
    }
  })
})

describe('角标的键不能撞号', () => {
  /**
   * folders.id 与 files.id 是两张表**各自**的自增主键，会撞号。
   *
   * 原来只有一个目录 map，所以撞不出来；把文件并进来就成了真 bug ——
   * 目录 2109 与文件 2109 会互相顶掉对方的角标。键必须带类型前缀。
   */
  test('badges map 的键带 folder-/file- 前缀', () => {
    const src = codeOnly(read(LIST))
    assert.match(
      src,
      /badgeKey\s*=\s*\(kind:\s*'folder'\s*\|\s*'file',\s*id:\s*FileListId\)\s*:\s*string\s*=>\s*`\$\{kind\}-\$\{id\}`/,
      'badgeKey 必须按 kind 加前缀 —— folders.id 与 files.id 会撞号，' +
        '共用一个无前缀的 map 会让两行互相顶掉角标'
    )
  })

  test('map 里两个表都收，且各自用对应前缀', () => {
    const src = codeOnly(read(LIST))
    assert.match(src, /for \(const f of props\.folders\) map\.set\(badgeKey\('folder', f\.id\), badgeOf\(f\)\)/)
    assert.match(src, /for \(const f of props\.files\) map\.set\(badgeKey\('file', f\.id\), badgeOf\(f\)\)/)
  })

  test('徽标 map 的键类型是 string（带前缀之后不再是 FileListId）', () => {
    const src = codeOnly(read(LIST))
    assert.match(
      src,
      /const badges = computed\(\(\) => \{\s*const map = new Map<string, ShareBadge \| null>\(\)/,
      '键类型得跟着前缀改成 string'
    )
  })
})

describe('角标的判定是共用的，不是各写一套', () => {
  test('badgeOf 收 FileListFile | FileListFolder，模板两行都走它', () => {
    const src = codeOnly(read(LIST))
    assert.match(
      src,
      /const badgeOf = \(item: FileListFile \| FileListFolder\): ShareBadge \| null =>\s*resolveShareBadge\(\{/,
      'badgeOf 必须同时接受文件和目录，且内部只调 resolveShareBadge'
    )
    // badgeOf 只在三态 + 名单上判定 —— 不许掺 presetActive / linkCount，
    // 那两个是红点的判据（shareDotReason）。掺进来会让「设了但没生效」的文件
    // 同时亮出角标，而它其实已经是 share 了。
    const body = src.slice(src.indexOf('const badgeOf'), src.indexOf('const badgeKey'))
    assert.doesNotMatch(
      body,
      /presetActive|linkCount/,
      'badgeOf 里不该出现 presetActive / linkCount —— 那是 shareDotReason 的输入'
    )
  })

  test('两行角标都取自同一个 badges map（没有第二份判定）', () => {
    const src = codeOnly(read(LIST))
    const calls = [...src.matchAll(/badges\.get\(badgeKey\('(folder|file)'/g)].map((m) => m[1])
    assert.equal(
      calls.filter((k) => k === 'folder').length,
      5,
      '目录行角标应有 5 处引用（v-if + title + aria-label + 两个 v-else-if）'
    )
    assert.equal(
      calls.filter((k) => k === 'file').length,
      5,
      '文件行角标应同样有 5 处引用 —— 少一处就是某条分支被漏掉了'
    )
  })
})

describe('条件齐备：服务端对文件也返回了这三个字段', () => {
  /**
   * 角标要亮起来，数据得在。文件不是 folders 表里的行，三个态字段
   * 直接来自 files 行；grantCount / linkCount 由 attachAccess 补，
   * presetActive 由 files/index.get.ts 的 withPreset 逐条算。
   *
   * 这几条是「角标不会恒为 null」的地基：字段缺一个，角标就永不显示，
   * 而模板测试照样全绿 —— 它只看结构，看不到数据。
   */
  test('files 表本身带 Shared / IsPublic', () => {
    const schema = read('server/database/schema.sql')
    // 表名后面可能带参数（`CREATE TABLE files (` / `IF NOT EXISTS files (`），
    // 所以只锚 `CREATE TABLE files`。
    const at = schema.indexOf('CREATE TABLE files')
    assert.ok(at > 0, 'schema 里找不到 files 表定义')
    // 收尾取**独占一行**的 `);`。第一版按第一个 `);` 切，于是切在注释里那行
    //   `-- 如果希望删除文件夹时保留文件，请改为：ON DELETE SET NULL)`
    // 上，Shared/IsPublic 两列落在切片之外，被判「表里没有」—— 测试自己错了。
    //
    // 切片必须**从 files 表起算**，不能只看 CHECK 存不存在：`CHECK (Shared IN
    // (0, 1, 2))` 在 schema 里有两份，folders 与 files 逐字相同（这是有意的，
    // 两张表的 Shared 语义一致）。只断言「schema 里有这个 CHECK」的话，
    // 删掉 files 那份照样绿。变异扫描里那条「删掉三态 CHECK」第一版就打歪了 ——
    // 改掉的是 folders 那份，files 的原封不动，看起来像断言没用。
    const body = schema.slice(at, schema.indexOf('\n);', at))
    assert.match(body, /Shared\s+INTEGER/, 'files 表没有 Shared 列，文件不可能有分享态')
    assert.match(body, /IsPublic\s+BOOLEAN/, 'files 表没有 IsPublic 列')
    // 三态的 CHECK 也得在：角标把 0/1/2 当三态解读，脏值由这层挡
    assert.match(body, /CHECK \(Shared IN \(0, 1, 2\)\)/, 'Shared 三态的 CHECK 约束不见了')
  })

  test('attachAccess 给每个文件算 grantCount 与 linkCount', () => {
    const src = codeOnly(read(DB))
    const at = src.indexOf('async attachAccess')
    assert.ok(at > 0, '没找到 attachAccess')
    const body = src.slice(at, at + 3000)
    assert.match(body, /file\.grantCount = grants\.length/, '文件没算 grantCount → 继承态下永远没角标')
    assert.match(body, /file\.linkCount = linkMap\.get\(file\.id\)/, '文件没算 linkCount')
  })

  test('文件列表接口给每个文件算 presetActive（红点与角标配套）', () => {
    const src = codeOnly(read('server/api/files/index.get.ts'))
    assert.match(
      src,
      /withPreset\(allFiles, \(f\) => fileService\.isPresetActiveForFile\(f\)\)/,
      '文件没算 presetActive → 文件行的红点永远不亮'
    )
  })

  test('FileListFile 类型声明了这三个字段', () => {
    const src = read(TYPES)
    const at = src.indexOf('export interface FileListFile')
    const body = src.slice(at, src.indexOf('\n}', at))
    for (const field of ['Shared?', 'IsPublic?', 'grantCount?', 'linkCount?']) {
      assert.match(body, new RegExp(`\\b${field.replace('?', '')}\\?:`), `FileListFile 缺 ${field}`)
    }
  })
})