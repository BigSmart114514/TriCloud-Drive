// 存储桶管理的接线断言。
//
// ## 为什么这类断言单独一个文件
//
// bucket-reconcile.test.mjs 测的是「算得对不对」（调真函数、注入假 db/lister）。
// 端点、菜单、页面守卫里全是**接线**，它们不出错的方式很特别：不报错，
// 只是「没接上」。而这个功能里每一条没接上的守卫都对应一次真实的越权或
// 一次误删：
//
//   /api/manage/ 整段只过 requireAdmin（放行 isAdmin || isSuperAdmin）
//     → 忘了换 requireSuperAdmin，普通管理员能删所有人的东西
//   没有命名空间校验
//     → 传别的用户的 key 就能删
//   没有「到点复查」
//     → 对账之后用户完成了一次上传，那个文件被当成孤儿删掉
//   purge 前没查 cosConfigured
//     → 每个 key 都删不掉，日志刷一片，界面显示「成功」
//
// 这些用正则断言「源码里有这句话」就够了 —— 它们不需要被执行，而执行反而
// 需要 mock 一整个 h3 环境。真正需要执行的分支都在 reconcile 那边测了。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** 剥注释。断言必须作用在真正会被执行的代码上 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join('\n')
}

const scriptOf = (p) => {
  const { descriptor, errors } = parse(read(p), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错`)
  return codeOnly(descriptor.scriptSetup?.content ?? '')
}
const templateOf = (p) => {
  const { descriptor, errors } = parse(read(p), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错`)
  return codeOnly(descriptor.template?.content ?? '')
}

const ENDPOINTS = [
  'server/api/manage/bucket/reconcile.post.ts',
  'server/api/manage/bucket/purge-orphans.post.ts',
  'server/api/manage/bucket/purge-dangling.post.ts',
  'server/api/manage/bucket/browse.get.ts',
  'server/api/manage/bucket/purge-log.get.ts'
]

describe('每个端点都要超管门控', () => {
  // /api/manage/ 整段过 requireAdmin（放行 isAdmin || isSuperAdmin）。
  // 忘了换 requireSuperAdmin 就是普通管理员能删所有人的东西。
  for (const p of ENDPOINTS) {
    test(`${p} 调 requireSuperAdmin 而不是 requireAdmin`, () => {
      const src = codeOnly(read(p))
      assert.match(
        src,
        /requireSuperAdmin\s*\(/,
        `${p} 必须用 requireSuperAdmin —— /api/manage/ 的 requireAdmin 放行普通管理员`
      )
      // 光 import 了不算，必须真的调用。`import { requireSuperAdmin }` 在
      // 一个只调 requireAdmin 的文件里完全合法，正则看得见前者看不见后者。
      assert.doesNotMatch(
        src.replace(/requireSuperAdmin\s*\(/g, ''),
        /\brequireAdmin\s*\(/,
        `${p} 里仍有 requireAdmin 的调用`
      )
    })
  }

  test('五个端点一个不多一个不少', () => {
    // 少一个不会有任何提示 —— 就是少了个功能。
    const onDisk = ENDPOINTS.filter((p) => {
      try { read(p); return true } catch { return false }
    })
    assert.equal(onDisk.length, ENDPOINTS.length)
  })

  test('requireSuperAdmin 本身是真的判 isSuperAdmin', () => {
    const src = codeOnly(read('server/utils/auth-middleware.ts'))
    const at = src.indexOf('export async function requireSuperAdmin')
    assert.ok(at > 0, '找不到 requireSuperAdmin')
    const body = src.slice(at, src.indexOf('\n}', at))
    assert.match(body, /!user\.isSuperAdmin/, '必须判 isSuperAdmin')
    assert.match(body, /statusCode:\s*403/, '必须抛 403')
    // 它内部过 requireAdmin —— 也就是「先要求管理员，再要求超管」，
    // 不是从 requireAuth 重来一遍。
    assert.match(body, /requireAdmin\s*\(/,
      '应该委托 requireAdmin（保持「登录 → 管理员 → 超管」的顺序）')
  })
})

describe('purge-orphans 的三道关卡', () => {
  const src = () => codeOnly(read('server/api/manage/bucket/purge-orphans.post.ts'))

  test('① 单次数量上限', () => {
    assert.match(src(), /MAX_KEYS_PER_REQUEST/, '必须有单次上限，否则一次能删十万个')
    assert.match(src(), /keys\.length > MAX_KEYS_PER_REQUEST/, '上限必须真的被检查')
  })

  // 这是结构性的守卫：让跨用户删除不可能发生，而不是「页面上禁掉了按钮」。
  test('② 逐 key 复查命名空间与「是否已有行」', () => {
    const s = src()
    assert.match(s, /recheckPurgeableKeys/, '必须走复查，不能直接信对账的快照')
    // 且复查失败时不能继续删
    assert.match(s, /recheckPurgeableKeys[\s\S]*?if \(ok\.length === 0\)[\s\S]*?throw createError/,
      '复查后没有可删的 key 时必须中止')
  })

  test('③ 审计在删除之前落库', () => {
    // 顺序是刻意的：COS 删除调不回来。先后删后记的话，COS 删成功而进程
    // 在写审计前被 SIGKILL，就留下一次无记录的真删除。
    const s = src()
    const audit = s.indexOf('recordPurge(')
    const del = s.indexOf('deleteCosObjects(')
    assert.ok(audit > 0, '找不到 recordPurge')
    assert.ok(del > 0, '找不到 deleteCosObjects')
    assert.ok(audit < del,
      '审计必须在删除之前 —— 后记的话，COS 删成功而进程崩在记录之前就无账可查了')
  })

  // 上一条只钉住了**文本位置**，而变异扫描立刻找到了它的漏洞：把调用包进一个
  // 从不执行的闭包（`const _later = async () => await recordPurge(...)`），
  // 文本位置没变，但审计永远不会被写。所以这里额外要求它处于语句位置。
  test('③ 审计调用是顶层语句，不是一个从不执行的闭包', () => {
    const line = src()
      .split('\n')
      .find((l) => l.includes('recordPurge(db,'))
    assert.ok(line, '找不到 recordPurge 的调用行')
    assert.match(
      line.trim(),
      /^await recordPurge\(/,
      '审计必须是一个被 await 的语句 —— 包进闭包会让它永远不执行，' +
        '于是顺序断言照样通过而实际无账可查'
    )
  })

  test('③ 审计里存的是真正要删的 key 集合（不是空数组）', () => {
    const s = src()
    const at = s.indexOf('recordPurge(db, {')
    const call = s.slice(at, at + 400)
    assert.match(call, /count:\s*ok\.length/, '条数必须是实际通过复查的数量')
    assert.match(call, /entries:\s*ok\.map\(/, '快照必须是真正要删的那批 key')
  })

  test('没配 COS 密钥时提前拒掉并说清原因', () => {
    // deleteCosObject 在没配密钥时对每个 key 都返回 false。不提前拒的话
    // 日志刷一片、界面显示「成功」，而实际上什么都没删。
    const s = src()
    assert.match(s, /cosConfigured\s*\(\)/, '必须查 cosConfigured')
    assert.match(s, /if \(!cosConfigured\(\)\)[\s\S]*?throw createError/,
      '没配密钥必须中止并说清，而不是安静地全失败')
  })

  test('不吞 deleteCosObjects 的失败数', () => {
    // 返回 failed 计数，页面才能说清「删了 3 个失败 1 个」而不是笼统的成功。
    assert.match(src(), /failed:/)
  })
})

describe('purge-dangling：不可逆所以要留痕，删完要重算', () => {
  const src = () => codeOnly(read('server/api/manage/bucket/purge-dangling.post.ts'))

  test('DELETE 必须带 user_id 条件', () => {
    // 凭 id 删东西是最容易写出越权的形状：传别人的 file id 过来，
    // `DELETE FROM files WHERE id = ?` 会老老实实删掉它。
    assert.match(
      src(),
      /DELETE FROM files WHERE user_id = \? AND id IN/,
      'DELETE 必须同时按 user_id 过滤 —— 只按 id 的话传别人 id 就删掉了'
    )
  })

  test('先复查 id 确实属于该用户', () => {
    assert.match(src(), /loadUserFileRows/, '必须重新读一次行')
    assert.match(src(), /byId/, '必须按 id 建索引再筛')
  })

  test('DELETE 与审计在同一个 SAVEPOINT 区间', () => {
    const s = src()
    assert.match(s, /SAVEPOINT purge_dangling_tx/, '必须开 SAVEPOINT')
    assert.match(s, /ROLLBACK TO purge_dangling_tx/, '必须有回滚')
    assert.match(s, /RELEASE purge_dangling_tx/, '必须有收口')
  })

  // SAVEPOINT 区间内早退 return 会把 SAVEPOINT 留在开启状态，之后所有语句
  // 都被卷进这个事务。那是 paste 那次踩过的坑（bulk.post.ts 的 settled 标志）。
  test('SAVEPOINT 区间内没有裸 return', () => {
    const s = src()
    const start = s.indexOf('SAVEPOINT purge_dangling_tx')
    const end = s.indexOf('RELEASE purge_dangling_tx')
    assert.ok(start > 0 && end > start, '找不到 SAVEPOINT 区间')
    const body = s.slice(start, end)
    // throw 是允许的（有 finally 收口）；return 不是。
    assert.doesNotMatch(body, /\breturn\b/,
      'SAVEPOINT 区间内不能有 return —— 会把 SAVEPOINT 留在开启状态')
  })

  test('有 settled 标志兜底', () => {
    const s = src()
    assert.match(s, /let settled = false/, '必须有 settled 标志')
    assert.match(s, /if \(!settled\)/, '必须在 finally 里检查')
  })

  // 悬空行删掉不重算的话，用户依然传不进去，而且比删之前更难查（行已经没了）。
  test('删完必须重算 usedStorage', () => {
    const s = src()
    assert.match(s, /recalculateUsedStorage/, '必须重算')
    assert.match(s, /storageRecalculated/, '必须把重算结果透出（失败时要能说出来）')
  })

  test('释放的字节数被算出来并透出', () => {
    // 「删完能多传多少」是悬空行清理最实际的价值，界面上要能显示它。
    const s = src()
    assert.match(s, /freedBytes/, '必须算并返回释放的字节数')
    assert.match(s, /fileSize/, '求和必须用 fileSize')
  })

  test('审计里保存了完整快照（不是只存 id）', () => {
    // 存 id 的话行已经没了，审计就失去了意义 —— 要能回答
    // 「删掉的到底是什么」，得存 filename / fileKey / folderId / createdAt。
    const s = src()
    // 用「四个字段都在」而不是逐字匹配那一段的写法 —— 字段顺序会变，
    // 而断言要守的是「快照够不够回答问题」，不是「代码长这样」。
    const payload = s.slice(s.indexOf('JSON.stringify('))
    for (const f of ['id', 'fileKey', 'filename', 'folderId', 'fileSize', 'createdAt']) {
      assert.match(payload, new RegExp(`\\b${f}:`),
        `payload 快照缺 ${f} —— 存 id 的话行已删，审计就答不出「删掉的到底是什么」`)
    }
  })

  test('kind 是 dangling-row（与孤儿区分）', () => {
    assert.match(src(), /'dangling-row'/)
  })
})

describe('cos-list：EncodingType 一个开关都不给', () => {
  const src = () => codeOnly(read('server/utils/cos-list.ts'))

  // 这是本功能里最狠的一个坑：一开就返回百分号编码的 Key，
  // `a b.txt` → `a%20b.txt`，差集永远匹配不上 —— 表现是
  // 「桶里每个文件都是孤儿」，而孤儿列表带删除按钮。
  test('源码里不出现 EncodingType', () => {
    assert.doesNotMatch(
      src(),
      /EncodingType/,
      'cos-list.ts 绝不能出现 EncodingType —— 一开就返回百分号编码的 Key，差集必崩'
    )
  })

  test('调用 SDK 时没有传 encoding 字段', () => {
    const s = src()
    const req = s.slice(s.indexOf('const req: Record<string, any>'))
    assert.doesNotMatch(req, /[Ee]ncoding/, 'getBucket 的请求参数里不能有 encoding')
  })

  test('列举失败时 throw（不返回空列表冒充「桶里什么都没有」）', () => {
    const s = src()
    assert.match(s, /if \(err\) reject\(err\)/,
      '必须 reject —— 空列表与列不出来分不开，而前者会让人以为桶是空的')
  })

  test('翻页中途失败返回 incomplete 而不是抛', () => {
    const s = src()
    assert.match(s, /incomplete\s*=\s*true/, '必须标 incomplete')
    assert.match(s, /第 \$\{pages \+ 1\} 页列举失败/,
      '必须写明是第几页失败的 —— 20 万个对象翻到第 37 页断了，「不完整」三个字不告诉人断在哪')
  })

  test('有翻页硬上限，防死循环', () => {
    const s = src()
    assert.match(s, /DEFAULT_MAX_PAGES/, '必须定义上限')
    // 两条都要：循环条件本身要判上限，且退出后还要再判一次「是不是被上限截断的」。
    // 只判前者的话，最后一页恰好用完 maxPages 时 incomplete 不会被置位。
    assert.match(s, /while \(pages < maxPages\)/, '循环条件必须受上限约束')
    assert.match(s, /if \(pages >= maxPages && !error\)/,
      '退出循环后要判是不是撞上限了 —— 只判循环条件的话，' +
        '最后一页恰好用完 maxPages 时 incomplete 不会被置位')
  })

  test('翻到上限时错误文案说清了是不完整', () => {
    // 只置 incomplete 不说原因的话，管理员看到「不完整」三个字不知道该怎么办。
    assert.match(src(), /超过翻页上限 \$\{maxPages\} 页/)
  })

  test('NextMarker 缺失时退回末条目（设了 Delimiter 时 COS 可能不给它）', () => {
    // 不退回就会死循环：marker 一直是 undefined，永远翻同一页。
    const s = src()
    assert.match(s, /data\?\.NextMarker/, '要读 NextMarker')
    assert.match(s, /fromResponse \|\| lastEntry \|\| marker \|\| null/,
      'NextMarker 缺失时要退回最后一个条目 —— 否则 marker 恒为 undefined，翻同一页直到天荒地老')
    assert.match(s, /if \(!nextMarker\)[\s\S]*?truncated:\s*false/,
      '三者都拿不到时如实标记不可翻页，而不是死循环')
  })

  // 判据跟着实现的形状走：原先查的是 `const lastEntry` 起算，而 noUncheckedIndexedAccess
  // 的修法把它拆成了 lastObject / lastPrefix 两个中间量，于是这条断言整段滑到了
  // 别处去（indexOf 返回 -1，slice(-1) 拿到文件末尾，恰好还匹配上了别的字样）。
  //
  // 「slice(-1) 不报错」正是这类断言最坏的失败方式：它不会让测试变红，它只是
  // 悄悄测了别的东西。所以这里先 assert.ok(indexOf > 0)，indexOf 失败要立刻响。
  test('lastEntry 在两种情况下都有取值（末对象 / 末目录）', () => {
    const s = src()
    const at = s.indexOf('const lastObject')
    assert.ok(at > 0, '找不到末条目的计算 —— 若这里报 indexOf 为 -1，说明下面的 slice 会滑到文件末尾')
    const body = s.slice(at, at + 400)
    assert.match(body, /objects\[objects\.length - 1\]/, '末个对象')
    assert.match(body, /commonPrefixes\[commonPrefixes\.length - 1\]/,
      '设了 Delimiter 时末条是目录而不是对象 —— 少了这一支就取不到')
    assert.match(body, /lastObject \|\| lastPrefix/, '两者取第一个非空')
  })
})

describe('browse：前缀必须由客户端点名', () => {
  const src = () => codeOnly(read('server/api/manage/bucket/browse.get.ts'))

  // 这个 bug 我写第一版时就犯过：`prefixes[0] + '/'` 永远只列 users/<id>/，
  // u/<id>/ 下一个都看不到，且没有任何提示 —— 界面上就是「这用户只有这些文件」。
  test('不写死 prefixes[0]', () => {
    assert.doesNotMatch(
      src(),
      /prefixes\[0\]/,
      '不能只取第一个前缀 —— 那样 u/ 下的文件全都不见了，而且没有任何报错'
    )
  })

  test('前缀从 allPrefixes 里 find（只接受这个用户的）', () => {
    assert.match(src(), /userKeyPrefixes\(userId\)/, '前缀必须由 userId 推导')
    assert.match(src(), /find\(\(p\) => p === requested\)/,
      '必须精确匹配允许列表里的一个，而不是 startsWith')
  })

  test('非法 prefix 直接 400，不 fallback', () => {
    // fallback 到第一个会让「忘了传」与「选错了」长得一模一样。
    assert.match(src(), /if \(!prefix\)[\s\S]*?throw createError/)
  })

  test('两个端点的失败语义是分开的（不做成一个带 flag 的接口）', () => {
    // browse 失败要抛（空列表会让人以为桶是空的），reconcile 不完整要标记。
    // 共用一个 flag 的话两种语义会挤到同一个字段上，而处置相反。
    assert.doesNotMatch(src(), /\bincomplete\b/, 'browse 只翻一页，不需要 incomplete')
  })
})

describe('页面与菜单', () => {
  test('auth.global.ts 对 /manage/bucket 单独判超管', () => {
    const s = codeOnly(read('app/middleware/auth.global.ts'))
    assert.match(s, /to\.path === '\/manage\/bucket'/, '必须显式判这条路由')
    assert.match(s, /to\.path === '\/manage\/bucket'[\s\S]*?!auth\.user\.value\?\.IsSuperAdmin[\s\S]*?navigateTo/,
      '非超管必须被弹走')
  })

  test('菜单只给超管显示存储桶管理', () => {
    const s = scriptOf('app/components/UiManageMenu.vue')
    assert.match(s, /IsSuperAdmin/, '菜单必须判超管')
    assert.match(s, /\/manage\/bucket/, '入口指向 bucket 页面')
    assert.match(s, /items\s*=\s*computed/, 'items 必须是 computed（角色要等 fetchUser 才有值）')
  })

  test('菜单不会 fallback 到全放行（不能用 isAdmin）', () => {
    // files.vue:50-56 有一条明确的警告：「千万别用 useAuth 的 isAdmin 来
    // 「有权限就全放行」—— 那个是 IsAdmin || IsSuperAdmin」。
    const s = scriptOf('app/components/UiManageMenu.vue')
    const at = s.indexOf('/manage/bucket')
    const window = s.slice(Math.max(0, at - 400), at)
    assert.doesNotMatch(window, /isAdmin\b/,
      '不能用 isAdmin 判定 —— 它对普通管理员也是 true，那样等于什么都不拦')
  })

  test('bucket.vue 自己也判了超管（客户端兜底）', () => {
    const s = scriptOf('app/pages/manage/bucket.vue')
    assert.match(s, /IsSuperAdmin/)
    assert.match(s, /navigateTo/, '必须跳走')
  })

  test('孤儿列表刻意没有全选', () => {
    const t = templateOf('app/pages/manage/bucket.vue')
    // 一行一个删除按钮。批量删除在 purge-orphans 里是支持的（keys 是数组），
    // 但页面不给出这个入口 —— 那个决策的理由要留在代码里。

    // 断言「没有勾选框」这件事，判据是**结构**而不是字面量：剥掉注释后，
    // 模板里不该有任何 type="checkbox"。第一版写的是 /全选|selectAll/，
    // 而「全选」这两个字恰恰出现在解释为什么不做全选的那段注释和
    // 屏幕阅读器用的 caption 里 —— 断言被自己的说明文字绊倒了。
    assert.doesNotMatch(t, /type="checkbox"/,
      '孤儿列表不能有勾选框 —— 有了它就等于有了批量删除入口')
    assert.doesNotMatch(t, /purgeOrphans\(|\.map\(o\s*=>/,
      '不能有「把选中项批量传给 purge」的处理函数')

    // 正向钉住：删除入口在每一行上渲染，且处理函数存在。
    // 判定分两处：模板里的调用（证明它在行内）与 script 里的定义（证明不是空壳）。
    // 「同一段源码里出现两次」这种判据在 template/script 分离后不成立 ——
    // templateOf 与 scriptOf 读的是两段不同的文本。
    assert.match(t, /@click="purgeOne\(o\)"/, '删除按钮在每行上绑定 purgeOne(o)')
    assert.match(t, /v-for="o in result\.orphans"/, '必须在每一行上渲染')
    assert.match(scriptOf('app/pages/manage/bucket.vue'), /function purgeOne\(/,
      'purgeOne 必须真的有实现')
  })

  test('per-row 删除传的是单元素数组（一次只删一个）', () => {
    const s = scriptOf('app/pages/manage/bucket.vue')
    assert.match(s, /keys:\s*\[o\.key\]/,
      '必须逐个删 —— 一次传一批就等于有批量删除入口了')
  })

  test('悬空行的一键删走两下确认', () => {
    const s = scriptOf('app/pages/manage/bucket.vue')
    assert.match(s, /useTwoStepConfirm/, '必须用两下确认')
    assert.match(s, /confirmingDangling\.click\(/, '必须真的走 click（第一下只置位）')
  })

  test('悬空行删除完自动复位确认态', () => {
    // 不复位的话按钮会卡在「确认删除？」，而第二次点击什么也不会发生。
    const s = scriptOf('app/pages/manage/bucket.vue')
    assert.match(s, /finally\s*\{[\s\S]*?confirmingDangling\.reset\(\)/,
      '必须在 finally 里复位')
  })

  test('换用户时清掉上一份结果', () => {
    // 不清的话界面上会短暂显示「A 用户有 12 个孤儿」而选择器已指向 B。
    const s = scriptOf('app/pages/manage/bucket.vue')
    const at = s.indexOf('async function runReconcile')
    const body = s.slice(at, at + 400)
    assert.match(body, /result\.value = null/, '对账前必须清掉旧结果')
  })

  test('incomplete 的提示显眼且说明了后果', () => {
    const t = templateOf('app/pages/manage/bucket.vue')
    assert.match(t, /v-if="result\.incomplete"/, '必须显著提示结果不完整')
    assert.match(t, /不产出悬空行/, '要说明悬空被压制了')
    assert.match(t, /禁用删除/, '要说明孤儿不能删了')
  })
})

describe('迁移与审计表', () => {
  const src = () => codeOnly(read('server/plugins/db-migrate.ts'))

  test('bucket_purge_log 建表了', () => {
    assert.match(src(), /CREATE TABLE bucket_purge_log/)
  })

  test('两种方言都有（D1/MySQL/SQLite 三个后端）', () => {
    const s = src()
    assert.match(s, /SQLITE_BUCKET_PURGE_LOG/)
    assert.match(s, /MYSQL_BUCKET_PURGE_LOG/)
  })

  test('迁移是幂等的（tableExists 判断）', () => {
    assert.match(
      src(),
      /if \(!\(await tableExists\(db, 'bucket_purge_log'\)\)\)/,
      '必须先判表在不在，否则第二次启动就报「表已存在」而拖垮启动'
    )
  })

  // 恰好在「用户投诉文件丢了」的时候把唯一的账本清掉。
  test('故意不建到 users 的外键', () => {
    const s = src()
    const at = s.indexOf('CREATE TABLE bucket_purge_log')
    const decl = s.slice(at, at + 600)
    assert.doesNotMatch(decl, /FOREIGN KEY|REFERENCES\s+users/i,
      '不能建到 users 的外键 —— ON DELETE CASCADE 会在删用户时把账本一起带走')
  })

  test('payload 是 TEXT/JSON 而不是外键到 files', () => {
    // 存外键的话行已经被删了，审计跟着失去意义。
    const s = src()
    assert.match(s, /payload\s+TEXT\s+NOT NULL/)
  })

  test('listPurgeLog 倒了序（最近的在最前）', () => {
    assert.match(codeOnly(read('server/utils/bucket-admin.ts')), /ORDER BY id DESC/)
  })

  test('两个删除方向都记账', () => {
    const b = codeOnly(read('server/utils/bucket-admin.ts'))
    const d = codeOnly(read('server/api/manage/bucket/purge-dangling.post.ts'))
    assert.match(b, /orphan-object/, '孤儿方向要记')
    assert.match(d, /dangling-row/, '悬空方向要记')
  })
})

describe('key 构造器的收敛', () => {
  // file-key.ts 的文件头写着「写全是为了让新增前缀时被迫想一下这里」。
  // 而内联的那份恰好把这条约定架空了。
  test('paste.post.ts 的 buildCosKey 是 export 的顶层函数，不是端点内联', () => {
    const s = codeOnly(read('server/api/copy/paste.post.ts'))
    assert.match(s, /^export function buildCosKey\(/m,
      '必须在顶层 export —— 内联那份就是「第三套 key 方案最容易长出来的地方」')
    assert.match(s, /^export function sanitizeForKey\(/m)
    assert.match(s, /^export function randomId\(/m)
  })

  test('内联那份已删掉（只剩一处定义）', () => {
    const s = codeOnly(read('server/api/copy/paste.post.ts'))
    const defs = [...s.matchAll(/function buildCosKey\(/g)]
    assert.equal(defs.length, 1, `buildCosKey 应只有一处定义，实际 ${defs.length} 处`)
  })

  test('两个前缀仍是权威清单（对账靠它遍历）', () => {
    const s = codeOnly(read('server/utils/file-key.ts'))
    assert.match(s, /FILE_KEY_PREFIXES = \['users', 'u'\]/,
      '前缀清单必须同时含两个 —— 漏一个就是「那个前缀下的文件全都不见了」')
  })

  test('listUserNamespaceObjects 遍历 FILE_KEY_PREFIXES 而不是写死', () => {
    const s = codeOnly(read('server/utils/cos-list.ts'))
    const at = s.indexOf('export async function listUserNamespaceObjects')
    const body = s.slice(at, at + 500)
    assert.match(body, /for \(const prefix of prefixes\)/,
      '必须遍历传进来的前缀列表，不能挑一个')
  })
})