// 对象浏览：/api/manage/bucket/browse 接界面。
//
// ## 分工
//
//   bucket-admin-wiring.test.mjs   browse 端点的门控与列举语义
//   本文件                          端点的前缀契约（放开后）+ 新页面 + 接线
//
// ## 为什么这个文件同时盯服务端和界面
//
// 因为这一轮**改了端点的契约**：前缀从「必须精确等于该用户的某个命名空间」
// 放开成「任意字符串」。那个精确匹配不是随手写的，它挡的是一个具体的坑
// （`prefixes[0] + '/'` 永远只列 users/，u/ 下的文件一个都看不到且没有任何
// 提示）。放开之后，那个坑的**替代品**是什么，必须由测试钉住，否则就等于
// 悄悄把一个防护换成了「靠界面记得显示」—— 那是把约束搬到人身上。
//
// 替代品是两条，都在下面：
//   ① 响应回显 prefix，页面把它**原样完整**显示出来（当前列举范围）
//   ② 拼错的 userId 直接 400 —— 不因为「前缀放开了」就让它悄悄变成整桶
//
// ## 为什么只能用源码断言
//
// 项目没有 @vue/test-utils / happy-dom（见 share-bulk-wiring.test.mjs 开头
// 同样的说明），也没有 Playwright。所以这份测试管的是「调用形式与接线」，
// 不是「渲染出来好不好看」。好不好看仍然得在浏览器里看一眼。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const ENDPOINT = 'server/api/manage/bucket/browse.get.ts'
const PAGE = 'app/pages/manage/browse.vue'
const MENU = 'app/components/UiManageMenu.vue'
const MIDDLEWARE = 'app/middleware/auth.global.ts'

/** 去掉注释。HTML 注释也要去 —— 少去一种，注释里提到的东西就能顶替断言（见
 *  tests/file-browser-toolbar.test.mjs 里记的那次实测）。 */
function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

function templateOf(p) {
  const { descriptor, errors } = parse(read(p), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错 —— 测试的输入本身有问题`)
  return codeOnly(descriptor.template?.content ?? '')
}

function scriptOf(p) {
  const { descriptor, errors } = parse(read(p), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错 —— 测试的输入本身有问题`)
  return codeOnly(descriptor.scriptSetup?.content ?? '')
}

const src = () => codeOnly(read(ENDPOINT))
const tpl = () => templateOf(PAGE)
const scr = () => scriptOf(PAGE)

/**
 * 取出某个函数的**函数体**（大括号配平），到它的收尾大括号为止。
 *
 * 为什么不用 `slice(indexOf(name), indexOf(name) + 700)`：那个窗口会跨进
 * 下一个函数。变异扫描实测过 —— 把 enterDir 里的游标归零删掉，那条断言照样绿，
 * 因为 700 字符里已经装进了 goNextPage，而它里面有 `markerStack`。
 * 「断言窗口里恰好有别的东西」是这类测试最常见的假绿来源。
 */
function fnBody(text, name) {
  const at = text.indexOf(name)
  assert.ok(at > 0, `找不到 ${name} —— 锚点没了，下面所有断言都会是恒真`)
  const open = text.indexOf('{', at)
  assert.ok(open > 0, `${name} 后面没有 {`)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  throw new Error(`${name} 的大括号没配平`)
}

describe('前缀放开：契约换成了什么', () => {
  test('前缀直接取自 query，不再要求精确等于某个命名空间', () => {
    // 被删掉的那条：allPrefixes.find((p) => p === requested)
    assert.doesNotMatch(
      src(),
      /find\(\(p\)\s*=>\s*p\s*===\s*requested\)/,
      '前缀不该再被钉死在 userKeyPrefixes 的某一项上 —— 这一轮就是要能下钻/换范围'
    )
    assert.doesNotMatch(
      src(),
      /prefixes\[0\]/,
      '更不能退回 prefixes[0] —— 那永远只列 users/，u/ 下的对象全都不见了'
    )
    // 正向：prefix 的来源是 query，缺省是空串
    assert.match(
      src(),
      /q\?\.prefix/,
      'prefix 必须来自 query（放开的前提是客户端能点任意范围）'
    )
  })

  test('空前缀 = 整个桶，而且这是写出来的默认、不是碰巧', () => {
    // 第一版这条是**假绿**：当时的代码里确实有一句
    // `const requested = q?.prefix ? String(q.prefix) : ''`，正则匹配上了，
    // 可那个值紧接着就被 `find` 拒掉 —— 空前缀在端点上根本不合法。
    // 断言要落在**生效**的那一处，而不是某个同形的中间变量上。
    assert.doesNotMatch(
      src(),
      /if\s*\(\s*!prefix\s*\)/,
      "空前缀合法（= 整个桶），不能再 400 —— 放开前缀后它就是「不加限制」"
    )
    // 生效的那一处：同一个变量既是缺省成 '' 的那个，也是传给列举的那个
    assert.match(
      src(),
      /const prefix = q\?\.prefix \? String\(q\.prefix\) : ''/,
      "prefix 必须由 query 缺省成 ''（= 整个桶）"
    )
    assert.match(
      src(),
      /listCosObjectsPage\(\{\s*prefix,/,
      '必须把这个 prefix 原样传给列举 —— 传别的值就等于前缀没放开'
    )
  })

  test('userId 可省略；但传了就必须是合法正整数（拼错不能悄悄变成整桶）', () => {
    // 省略 = 不给快捷前缀，范围就是 prefix 说的那个。
    assert.match(
      src(),
      /q\?\.userId/,
      'userId 仍可从 query 读（用于给出该用户的命名空间快捷方式）'
    )
    // 关键：这不是「不校验」。放开前缀之后，一个打错的 userId 若被忽略，
    // 范围会从「某人两个命名空间之一」静默放大到「整桶」—— 比原来的 bug 更糟。
    assert.match(
      src(),
      /Number\.isSafeInteger\([\s\S]{0,80}userId/,
      'userId 一旦出现就必须校验（Number.isSafeInteger）'
    )
    assert.match(
      src(),
      /hasUserId[\s\S]{0,200}throw createError/,
      '传了非法 userId 必须 400，不能当没传'
    )
  })

  test('前缀长度有上限（放开不等于随便塞一兆字节进 URL）', () => {
    assert.match(src(), /MAX_PREFIX_LEN/, '必须有前缀长度上限常量')
    assert.match(
      src(),
      /prefix\.length\s*>\s*MAX_PREFIX_LEN[\s\S]{0,200}throw createError/,
      '超长前缀必须 400 —— 列举没必要为它翻页，而它会撑爆 URL'
    )
  })

  test('allPrefixes 仍由服务端算（快捷方式不能在前端重推命名空间）', () => {
    assert.match(
      src(),
      /userKeyPrefixes\(/,
      '命名空间列表必须来自 userKeyPrefixes —— 前端重推一份就是 b5c74a8 记的那个教训'
    )
    // 没有 userId 时不该凭空造出 list
    assert.match(
      src(),
      /userId\s*\?\s*userKeyPrefixes\(userId\)\s*:\s*\[\]/,
      '没给 userId 时 allPrefixes 应为空数组，而不是 defaults 到某个用户'
    )
  })

  test('列举失败仍然要抛（放开前缀不改变失败语义）', () => {
    // 空列表与「列不出来」必须分得开，否则整桶前缀下「0 个对象」会被读成「桶是空的」
    assert.doesNotMatch(src(), /\bcatch\b[\s\S]{0,200}objects:\s*\[\]/,
      '不能把列举失败吞成空列表')
    assert.match(src(), /await listCosObjectsPage\(/, '必须真的等它，不 fire-and-forget')
  })

  test('回显 prefix（放开之后，「现在到底在列什么」由这个字段负责说清）', () => {
    assert.match(src(), /\bprefix,/, '响应必须回显 prefix，页面据此显示当前范围')
  })

  test('响应带上 cosConfigured（否则界面上分不出「没配密钥」与「桶是空的」）', () => {
    // cos-list.ts 在没配密钥时如实返回**空列表且不带 error**（demoMode 下桶里
    // 确实什么都没有，这没说错）。于是在界面上两种情况长得一模一样：
    //   没配密钥   → 0 个对象
    //   真的空桶   → 0 个对象
    // 而这一页默认列的是**整个桶**，猜错一次就是「以为整个桶空了」。
    //
    // 兄弟页 bucket.vue 就是在这一点上翻车的：它的 `cosConfigured` 是
    // `ref(true)` 且从没被赋成 false，那条横幅因此永远不会出现。所以这里
    // 额外禁掉「写死 true」——那正是让这条断言变成摆设的做法。
    assert.match(src(), /cosConfigured/, '端点必须报出凭据是否可用')
    assert.match(
      src(),
      /cosConfigured:\s*cosConfigured\(\)/,
      '必须是 cosConfigured() 的真实返回值，不能写死 true'
    )
  })
})

describe('页面：/manage/browse', () => {
  test('页面存在，且是超管页的三件套（layout: false / NavBar / 客户端兜底）', () => {
    const t = tpl()
    const s = scr()
    assert.match(s, /definePageMeta\(\{\s*layout:\s*false\s*\}\)/,
      '必须 layout: false —— 本项目没有 layouts/，与 manage/ 其余页一致')
    assert.match(t, /^\s*<AppNavbar\b/m,
      '必须有 <AppNavbar /> —— 顶栏靠每页自己放，少了它既进不去也出不来')
    assert.match(s, /IsSuperAdmin/, '必须判 IsSuperAdmin')
    assert.match(s, /navigateTo/, '非超管必须被弹走（客户端兜底）')
    assert.match(
      s,
      /^\s*import \{ useAuth \} from '~\/composables\/useAuth'/m,
      '必须显式 import useAuth —— 自动导入注入失败过一次，代价是 SSR 500'
    )
  })

  test('前缀是自由文本，且当前范围被原样完整显示', () => {
    // ① 放开之后，界面唯一的防「看错范围」手段就是这个显示
    const t = tpl()
    assert.match(t, /v-model="prefixInput"/, '必须有前缀输入框（自由文本）')
    assert.match(
      t,
      /\{\{\s*displayedPrefix\s*\}\}/,
      '必须把当前列举范围原样显示出来 —— 放开前缀后这是唯一的护栏'
    )
    // ② 整桶的表示法要说清：空串在界面上必须读作「整个桶」而不是空白
    assert.match(
      scr(),
      /function displayedPrefix\(|displayedPrefix\s*=\s*computed/,
      '必须有 displayedPrefix 这个显式换算，空前缀要显示成「整个桶」'
    )
  })

  test('分组开关真的传 group=dir（commonPrefixes 才是目录树）', () => {
    assert.match(tpl(), /v-model="groupByDir"/, '必须有「按目录分组」开关')
    assert.match(
      scr(),
      /group:\s*groupByDir\.value\s*\?\s*'dir'/,
      "必须传 group: 'dir' —— 服务端只认这个值才做 delimiter"
    )
  })

  test('commonPrefixes 里的目录能点进去（这才是「浏览」）', () => {
    const t = tpl()
    assert.match(t, /v-for="d in page\.commonPrefixes"/, '必须渲染 commonPrefixes')
    assert.match(t, /@click="enterDir\(d\)"/, '目录必须可点进去')
    assert.match(scr(), /function enterDir\(/, 'enterDir 必须有实现')
  })

  test('进入子目录时换掉前缀并清掉游标（否则下一页串到别的范围）', () => {
    const body = fnBody(scr(), 'function enterDir')
    assert.match(body, /prefixInput\.value\s*=/, '必须把前缀换成那个目录')
    // 判据必须在 **enterDir 自己的函数体**里，不能是「enterDir 前后 700 字符」
    // —— 那个窗口装得下 goNextPage，而它里面就有 markerStack（实测假绿过一次）
    assert.match(
      body,
      /markerStack\.value\s*=\s*\[undefined\]/,
      '必须在这里把游标栈归零 —— 游标来自上一个列举序列，范围一换带着它翻页会串位'
    )
  })

  test('下一页由 truncated 把门，且函数自己也再判一次', () => {
    // 模板的 :disabled 是第一道；函数里这一句是第二道。少第二道时有个窄缝：
    // truncated 为真但 nextMarker 为空（列举在边界上给不出游标），栈里会被压进
    // null，下一页实际重列第一页，而页码显示已经 +1。
    const body = fnBody(scr(), 'function goNextPage')
    assert.match(
      body,
      /!page\.value\?\.truncated[\s\S]{0,120}return/,
      'goNextPage 必须自己判 truncated —— 不能只靠按钮的 disabled'
    )
  })

  test('下一页用 nextMarker，上一页靠游标栈（COS 的 marker 只能向前）', () => {
    const s = scr()
    // 向前
    assert.match(s, /nextMarker/, '必须用 nextMarker')
    assert.match(s, /function goNextPage\(/, '必须有「下一页」')
    // 向后：marker 是不透明游标，没有「上一页」API，只能自己存一路
    assert.match(
      s,
      /markerStack|trail/,
      '必须有游标栈 —— COS 的 marker 只能向前，没有上一页这个 API'
    )
    assert.match(s, /function goPrevPage\(/, '必须有「上一页」')
    assert.match(
      tpl(),
      /:disabled="!canGoPrev"/,
      '上一页按钮的禁用态必须跟着游标栈，不能永远可点'
    )
  })

  test('truncated 决定有没有下一页（truncated 为假时 nextMarker 无意义）', () => {
    assert.match(
      tpl(),
      /:disabled="!page\.truncated/,
      '下一页必须由 truncated 把门 —— 否则最后一页会一直给一个无效游标'
    )
  })

  test('下载复用已有的 download 端点（不新造一条签名路径）', () => {
    assert.match(
      scr(),
      /\/api\/manage\/bucket\/download/,
      '必须走 /api/manage/bucket/download —— 签名逻辑只有那一份（bucket-download.test.mjs 钉着）'
    )
    assert.match(tpl(), /@click="downloadOne\(o\)"/, '每行都要有下载入口')
  })

  test('列举是只读的：界面上不能出现任何删除入口', () => {
    // browse 是 GET，页面上也不该有删除。理由与 orphan 列表「没有全选」同源：
    // 删除不可逆，而这里列的是**整桶任意前缀**，比孤儿列表的范围大得多。
    const t = tpl()
    assert.doesNotMatch(t, /@click="[^"]*[Pp]urge/, '浏览页不能有清理入口')
    assert.doesNotMatch(t, /@click="[^"]*delete/, '浏览页不能有删除入口')
    assert.doesNotMatch(scr(), /purge-orphans|purge-dangling/, '不能调任何清理端点')
  })

  test('部分列举失败要显眼（error 不等于「没有对象」）', () => {
    // listCosObjectsPage 可能在拿到一部分结果的同时带上 error。
    // 界面上把它当「空」显示，就是在说谎 —— 而这一页列的是整桶。
    // 判据必须带 `page &&`：模板里写裸的 `v-if="page.error"`，而 page 初始是
    // null，Vue 求值时直接抛 —— 那一屏就白了。第一版这条写成 /page\.error/，
    // 于是把「加了空值保护」的正确实现判成了不合格。判据要按对的写法写。
    assert.match(
      tpl(),
      // \b 而不是直接收尾：`page.error && page.error.length` 与 `page.error`
      // 语义相同，判据不该把「多一个无害条件」当成违规（变异扫描的 B 段抓到过）。
      // 要守的是「带 page 非空保护」，不是「后面再也不能跟东西」。
      /v-if="page\s*&&\s*page\.error\b/,
      '必须显示 page.error（且带 page 非空保护 —— page 初始为 null）'
    )
    assert.match(
      tpl(),
      /列举未能完成|不完整/,
      '措辞要说清「没列完」，而不是让它读起来像「桶里就这些」'
    )
  })

  test('快捷前缀来自响应，不在前端算（前端一重推就会和 FILE_KEY_PREFIXES 分叉）', () => {
    assert.match(scr(), /allPrefixes/, '必须用响应里的 allPrefixes 当快捷方式')
    assert.doesNotMatch(
      scr(),
      // 第一版写的是 /\['users'/ —— 那个模式要求 users 后面紧跟一个引号，
      // 而真代码里是 ['users/1/', …]，所以变异把命名空间硬编码进来之后
      // 这条断言**照样绿**。判据要卡在斜杠上，不是引号上。
      /['"`]users\/|FILE_KEY_PREFIXES|\bu\s*:\s*u\//,
      '界面上不能硬编码命名空间 —— 那条知识在 server/utils/file-key.ts，' +
        '复制一份就会分叉（b5c74a8 记的就是这个）'
    )
  })

  test('空前缀在界面上显示成明确的话，不能是一片空白', () => {
    // 这一页默认就是空前缀（整个桶）。显示成空白会被读成「没在列任何东西」，
    // 而不是「在列所有东西」。
    assert.match(
      scr(),
      /page\.value\.prefix\s*\|\|\s*'[^']+'/,
      "displayedPrefix 必须在 prefix 为空时给一个非空的说法（如「整个桶」）"
    )
  })

  test('换用户 / 换前缀不会留下上一份范围的结果', () => {
    // 界面上留着 A 的结果而输入框已经指向 B，是会误导人的
    const s = scr()
    const at = s.indexOf('async function runBrowse')
    assert.ok(at > 0, '找不到 runBrowse')
    const body = s.slice(at, at + 900)
    assert.match(body, /page\.value\s*=\s*null|clearResult/, '请求前必须清掉旧结果')
  })

  test('输入框回显服务端给的 prefix（回显优先于输入，不是反过来）', () => {
    // displayedPrefix 优先读 page.prefix，界面上那一行才是「真的列了什么」。
    // 若输入框仍留着自己那份而两者不一致（比如服务端做了归一化，或将来
    // 端点对前缀做了任何处理），操作者看到的就是一个**没被列**的字符串。
    // 少这一句时 displayedPrefix 与输入框会各说各话，而且两处都在页面上。
    const s = scr()
    const at = s.indexOf('async function runBrowse')
    assert.ok(at > 0, '找不到 runBrowse')
    assert.match(
      s.slice(at, at + 900),
      /prefixInput\.value\s*=\s*page\.value\.prefix/,
      '必须用服务端回显的 prefix 覆盖输入框'
    )
    assert.match(
      s,
      // 两种写法都认：computed(...) 或 function declaredPrefix() —— 上面那条
      // 测试已经允许后者了，这条再硬要求 computed 就成了同一属性两套语法要求，
      // 变异扫描的 B 段（把 computed 换成等价的 function）当场报「竟然抓到」。
      // 守的是「优先读 page.value.prefix」，不是「必须写成 computed」。
      /displayedPrefix\s*=\s*computed\([\s\S]{0,80}?page\.value\s*\?\s*page\.value\.prefix|function displayedPrefix\(\)[\s\S]{0,200}?page\.value\s*\?\s*page\.value\.prefix/,
      'displayedPrefix 必须优先读 page.value.prefix'
    )
  })

  test('「没配密钥」在这页也要说（和 bucket.vue 同一个判断）', () => {
    // demoMode 下服务端如实返回 0 个对象。界面上「0 个对象」和「没有凭据」
    // 长得一模一样 —— bucket.vue 已经为此加过提示，这一页不能重复那个坑。
    assert.match(tpl(), /cosConfigured/, '必须有 cosConfigured 提示')
  })
})

describe('接线：新路由要过三道关卡', () => {
  test('auth.global.ts 对 /manage/browse 也判超管', () => {
    const s = codeOnly(read(MIDDLEWARE))
    // 拆成两条，判据要**紧**。
    //
    // 第一版是一条大窗口正则 `new Set\(…'/manage/browse'…IsSuperAdmin`，看起来
    // 同时要求了「在集合里」和「与 IsSuperAdmin 一起当门」。实测是假的：把
    // `superOnly.has(to.path) && !auth.user.value?.IsSuperAdmin` 换成 `if (false)`
    // 之后它照样绿 —— 因为再往下 180 字符处还有另一个 IsSuperAdmin
    // （文件末尾的 /api/manage 那段），窗口够得到，就替集合那条门答了。
    //
    // 「窗口里恰好有别的东西」和注释一样，是让源码断言变废的两条路。
    assert.match(
      s,
      /const superOnly = new Set\(\[[^\]]*'\/manage\/browse'/,
      "/manage/browse 必须在超管集合里"
    )
    assert.match(
      s,
      /superOnly\.has\(to\.path\)\s*&&\s*!auth\.user\.value\?\.IsSuperAdmin/,
      '那个集合必须真的与 IsSuperAdmin 一起当门（否则集合只是个摆设）'
    )
    // 反向：不能因为集合判了就忘了跳转，普通管理员仍要落到 /manage/files
    assert.match(
      s,
      /IsSuperAdmin\)\s*\{\s*return navigateTo\('\/manage\/files'\)/,
      '非超管必须被弹去 /manage/files'
    )
  })

  test('UiManageMenu 有入口，且只在超管那一档里', () => {
    const s = scriptOf(MENU)
    assert.match(s, /\/manage\/browse/, '菜单要有这个入口（没入口 = 只能手敲 URL）')
    // 它必须落在 IsSuperAdmin 那一支里，不能混进 all（普通管理员可见）
    const at = s.indexOf('/manage/browse')
    assert.ok(at > 0, '菜单里找不到 /manage/browse')
    const guard = s.lastIndexOf('if (!auth.user.value?.IsSuperAdmin) return all', at)
    assert.ok(guard > 0, '/manage/browse 出现在超管判定之前 —— 那等于普通管理员也看得见')
  })

  test('manage-pages-scope-import 的清单里要有这一页', () => {
    // 那个文件的 MANAGE_PAGES 是**硬编码数组**，不是扫目录 ——
    // 漏加不会报错，只会让这一页不受「必须显式 import useAuth」的约束。
    const s = codeOnly(read('tests/manage-pages-scope-import.test.mjs'))
    assert.match(s, /'app\/pages\/manage\/browse\.vue'/,
      'MANAGE_PAGES 是硬编码的，漏加这一页等于放弃它的 useAuth 断言')
  })
})
