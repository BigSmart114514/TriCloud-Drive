// 孤儿对象的下载：签名链接 + 从 key 反推文件名。
//
// ## 为什么核心是 displayNameFromKey
//
// 「无条件签名」意味着服务端不要求 key 有 files 行，所以唯一的输入就是一个
// 字符串。而两种 key 格式携带的信息量**不一样**，这正是需要如实区分的地方：
//
//   u/<id>/<日期>/<ts>_<rand>_<名字>     名字在 key 里 → 能还原
//   users/<id>/<YYYYMM>/<uuid><ext>       只有 uuid。原名只存在于那一行 files
//                                         的 filename 列，而那一行已经没了
//
// 不区分的后果很具体：界面上会给一串 32 位 hex 配一个「下载」按钮，操作者以为
// 那是文件名，点开发现不对再回头找 —— 而那份信息已经永久消失了。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { displayNameFromKey } = await import('../server/utils/file-key.ts')
const { generateCDNUrl, cosDirectUrl } = await import('../server/utils/cdn-sign.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

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

describe('displayNameFromKey：复制路径能还原文件名', () => {
  test('u/ 前缀取下划线后的原名', () => {
    const r = displayNameFromKey('u/141/2026-10-07/1757212800000_a1b2c3_季度报表.xlsx')
    assert.equal(r.name, '季度报表.xlsx')
    assert.equal(r.recoverable, true, '名字就在 key 里，必须标成可还原')
  })

  test('原名里含下划线时只去掉前两段', () => {
    const r = displayNameFromKey('u/141/2026-10-07/1757_ab_report_2026_final.pdf')
    assert.equal(r.name, 'report_2026_final.pdf', '只剥 ts_rand_，原名内部的下划线要留着')
  })

  test('原名里有数字段不会被误当成时间戳', () => {
    // 正则是 ^\d+_[a-z0-9]+_ 且只吃一次 —— 第三次出现的下划线属于原名。
    const r = displayNameFromKey('u/1/2026-01-01/100_abc_2024_05_报表.xlsx')
    assert.equal(r.name, '2024_05_报表.xlsx')
  })

  test('u/ 前缀但形状不认时仍返回末段，只是不标可还原', () => {
    const r = displayNameFromKey('u/141/2026-10-07/justafile.txt')
    assert.equal(r.name, 'justafile.txt')
    assert.equal(r.recoverable, false, '形状认不出来就不能说「还原成功」')
  })
})

describe('displayNameFromKey：上传路径不能还原，如实说', () => {
  // 这一条是整个 helper 的核心。上传侧生成的是 uuid + 扩展名，
  // 原名从来没有进过 key —— 它只在 files.filename 那一列里，而行已经没了。
  test('uuid 形式标成不可还原', () => {
    const r = displayNameFromKey('users/141/202610/9f8e7d6c-5b4a-3210-fedc-ba9876543210.zip')
    assert.equal(r.name, '9f8e7d6c-5b4a-3210-fedc-ba9876543210.zip', '末段是能给下载用的名字')
    assert.equal(r.recoverable, false, '★ 原名不在 key 里，必须如实说不可还原')
  })

  test('users/ 前缀即使末段看着像名字也不标可还原', () => {
    // 反例容易想当然：'users/1/202610/报告.xlsx' 这种 key 项目自己不会生成，
    // 但如果传进来就标 recoverable=true，那界面会显示「可还原」而实际不是。
    const r = displayNameFromKey('users/1/202610/报告.xlsx')
    assert.equal(r.recoverable, false, '不能因为末段像名字就乐观 —— users/ 的格式保证不了这点')
  })

  // 未知前缀 + u/ 的形状：**必须**说不可还原。
  //
  // 判据要挑一个能区分的输入。第一版用的是 `weird/abc/def.txt`，
  // 而那个串本来就不匹配 ts_rand_name 的形状 —— 于是即便有人把
  // 「u 的分支」放宽到「任何前缀」，它也会走那条分支里的兜底（返回 false），
  // 结果一模一样。测试因此毫无作用。
  //
  // 这里用 `weird/141/2026-10-07/1757_ab_报表.xlsx`：形状是能还原的，
  // 只差前缀不认。它必须仍是 false —— 认不出的格式就不能声称还原成功。
  test('未知前缀即使形状像 u/ 也标不可还原', () => {
    const r = displayNameFromKey('weird/141/2026-10-07/1757_ab_报表.xlsx')
    assert.equal(r.recoverable, false,
      '★ 认不出的前缀不能乐观 —— 万一它其实是别的格式，那段解析就是猜的')
    // 而且文件名要退回末段，而不是假装自己还原出了「报表.xlsx」
    assert.equal(r.name, '1757_ab_报表.xlsx',
      '不该套用 u/ 的解析去猜一个别的格式的文件名')
  })

  test('未知前缀的普通文件也标不可还原', () => {
    assert.equal(displayNameFromKey('weird/abc/def.txt').recoverable, false)
  })
})

describe('displayNameFromKey：脏输入不炸', () => {
  test('空串 / null / undefined / 非字符串', () => {
    for (const v of ['', null, undefined, 42, {}, []]) {
      const r = displayNameFromKey(v)
      assert.equal(r.name, '', `${JSON.stringify(v)} 应得到空名`)
      assert.equal(r.recoverable, false)
    }
  })

  test('只有前缀没有末段（users/5/ 结尾）', () => {
    const r = displayNameFromKey('users/5/')
    assert.equal(r.name, '', 'slice 之后是空串，不能变成 "users/5/"')
    assert.equal(r.recoverable, false)
  })

  test('没有斜杠的裸字符串', () => {
    const r = displayNameFromKey('bare.txt')
    assert.equal(r.name, 'bare.txt')
    assert.equal(r.recoverable, false)
  })

  test('多段路径取的是最后一段', () => {
    assert.equal(displayNameFromKey('a/b/c/d.txt').name, 'd.txt')
  })
})

describe('签名本身：抽出后行为未变', () => {
  const CFG = {
    domain: 'cdn.example.com',
    primary: 'primary-secret',
    backup: 'backup-secret',
    ttl: 10,
    param: 'sign'
  }

  test('生成的 URL 带签名参数', () => {
    const url = generateCDNUrl('users/1/202610/a.txt', CFG.domain, CFG.primary, CFG.backup, CFG.ttl, CFG.param)
    assert.match(url, /^https:\/\/cdn\.example\.com\/users\/1\/202610\/a\.txt\?/)
    assert.match(url, /sign=\d+-\d+-0-[0-9a-f]{32}/, 'TypeA 形状：时间戳-随机-uid-md5')
  })

  test('签名只取决于 path/ttl/primaryKey（backupKey 不参与）', () => {
    // 既有行为：形参有 backupKey 但函数体只用 primaryKey。这里钉住它，
    // 免得有人「顺手修一下」而没意识到要连着改 CDN 后台配置。
    //
    // 必须把 Math.random 换掉才能比：签名里有 rand 段，两次调用本来就不同，
    // 拿整个 URL 去比是在比随机数（第一版就这么写的，报了个假失败）。
    const realRandom = Math.random
    Math.random = () => 0.5
    try {
      const a = generateCDNUrl('users/1/a.txt', CFG.domain, CFG.primary, 'OTHER', CFG.ttl, CFG.param, 'x.txt')
      const b = generateCDNUrl('users/1/a.txt', CFG.domain, CFG.primary, CFG.backup, CFG.ttl, CFG.param, 'x.txt')
      assert.equal(a, b, 'backupKey 换成什么都不该影响结果')
    } finally {
      Math.random = realRandom
    }
  })

  test('文件名被编码进 Content-Disposition', () => {
    const url = generateCDNUrl('users/1/a.txt', CFG.domain, CFG.primary, CFG.backup, CFG.ttl, CFG.param, '季度 报表.xlsx')
    assert.match(url, /response-content-disposition=attachment/)
    // URLSearchParams 自己会做百分号编码，所以**在 URL 字符串里看不到**
    // 有没有 encodeURIComponent 的差别 —— 两个版本都表现为「没有裸奔的中文」。
    //
    // 而那个差别是真的：CDN 收到的是解码一次之后的值。
    //   有：%E5%AD%A3…   （CDN 解一次得到正常文件名）
    //   无：季度 报表.xlsx（直接是非 ASCII 出现在头里）
    //
    // 所以判据放在源码上：这一行必须带着 encodeURIComponent。
    // 这是既有行为，抽 cdn-sign.ts 时逐字未动，不该被悄悄「简化」掉。
    const signSrc = codeOnly(read('server/utils/cdn-sign.ts'))
    const line = signSrc.split('\n').find((l) => l.includes('response-content-disposition'))
    assert.ok(line, '找不到 Content-Disposition 那一行')
    assert.match(line.trim(), /encodeURIComponent\(filename\)/,
      'filename 必须经 encodeURIComponent 再交给 params.set')
  })

  test('不给文件名时就不带 Content-Disposition', () => {
    const url = generateCDNUrl('users/1/a.txt', CFG.domain, CFG.primary, CFG.backup, CFG.ttl, CFG.param)
    assert.doesNotMatch(url, /response-content-disposition/)
  })

  test('直链形状不变', () => {
    assert.equal(
      cosDirectUrl('mybucket-1250000000', 'ap-guangzhou', 'users/1/a.txt'),
      'https://mybucket-1250000000.cos.ap-guangzhou.myqcloud.com/users/1/a.txt'
    )
  })

  test('download.post.ts 不再自带一份签名（抄两份是最坏的选择）', () => {
    const s = codeOnly(read('server/api/files/download.post.ts'))
    assert.match(s, /from '~~\/server\/utils\/cdn-sign'/, '必须从共享模块取')
    assert.doesNotMatch(s, /createHash\(/, '不能在本文件里再写一份签名算法')
    assert.doesNotMatch(s, /authString/, '同上')
    // crypto 的 import 也随之失效，留着就是个误导（文件里已不再用它）
    assert.doesNotMatch(s, /^import crypto/m, 'crypto 已不再使用，import 应删掉')
  })
})

describe('download 端点：无条件，但门控与基本校验都在', () => {
  const src = () => codeOnly(read('server/api/manage/bucket/download.get.ts'))

  test('超管门控（不能退回 requireAdmin）', () => {
    assert.match(src(), /requireSuperAdmin\s*\(/)
  })

  // 「无条件」是明确的产品决定：给什么 key 签什么 key。
  // 所以这里要**钉住**它没有命名空间守卫 —— 否则将来有人出于「安全」加回去，
  // 而需求已经变了。
  test('刻意不做命名空间校验（用户明确要无条件）', () => {
    const s = src()
    assert.doesNotMatch(s, /userKeyPrefixes/,
      '无条件签名意味着不按命名空间收窄 —— 加回来就违背了需求')
    assert.doesNotMatch(s, /fileKeyOwnerId/,
      '不校验属主。读操作 + 超管 + 签名会过期，与删除的严格程度故意不同')
  })

  // 上一条只挡了两种**具体写法**。变异扫描立刻补了第三种（`key.startsWith('users/')`）
  // 就溜过去了 —— 断言枚举实现细节，就只挡得住被枚举的那几种。
  //
  // 这里改成枚举 **key 被检查了哪些属性**，新增任何一项都会红。
  // 代价是将来加一个合理的校验（比如长度）也要改这里 —— 那正是想要的效果：
  // 「无条件」是个产品决定，改它应该是有意识的，不是顺手。
  test('对 key 的检查只有三项（无命名空间类校验）', () => {
    const s = src()
    const checks = [...new Set([...s.matchAll(/\bkey\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort()
    assert.deepEqual(checks, ['includes', 'length', 'trim'],
      `对 key 的检查多了一项或少了一项：${checks.join(', ')}。` +
        '新增命名空间/属主类校验会让「无条件」这个产品决定失效')
  })

  // 同理，「不要求它有 files 行」也不能靠枚举某个函数名来钉。
  // 无条件签名器**一个数据库都不该碰**：它拿到 key 就签，签完就走。
  test('完全不碰数据库（孤儿没有 files 行，查了就会把它拒掉）', () => {
    const s = src()
    assert.doesNotMatch(s, /getDb|db-adapter/, '无条件签名不该读数据库')
    assert.doesNotMatch(s, /\bdb\./, '无条件签名不该查库 —— 那正是 orphans 走不通 /api/files/download 的原因')
    assert.doesNotMatch(s, /SELECT/i, '不该有任何 SQL')
  })

  test('仍然挡住「不是一个 key」的两类坏输入', () => {
    const s = src()
    assert.match(s, /typeof key !== 'string' \|\| !key\.trim\(\)/, '空值要拒')
    assert.match(s, /key\.length > 1024/, '长度要有上限')
    // 换行能把 Content-Disposition 的头打散 —— 不是安全问题，是不能签出坏请求
    assert.match(s, /key\.includes\('\\n'\)/, '换行要拒')
  })

  test('没有 CDN 域名时退回 COS 直链', () => {
    const s = src()
    assert.match(s, /const useCDN = !!config\.cdnDomain/)
    assert.match(s, /cosDirectUrl\(/)
    assert.match(s, /未配置存储桶/, '没配桶要拒，不能签出一个指向空域名的 URL')
  })

  test('透出 filenameRecoverable（界面据此提醒）', () => {
    assert.match(src(), /filenameRecoverable: name\.recoverable/)
    assert.match(src(), /displayNameFromKey\(key\)/, '文件名必须从 key 反推')
  })

  test('透出 expiresAt，与 files/download 同一口径', () => {
    const s = src()
    assert.match(s, /expiresAt: new Date\(Date\.now\(\) \+ /)
    assert.match(s, /cdnAuthTtl/, '用同一个配置')
  })
})

describe('页面：下载在删除旁边，且不随 deletable 一起禁用', () => {
  const t = () => templateOf('app/pages/manage/bucket.vue')
  const s = () => scriptOf('app/pages/manage/bucket.vue')

  test('两个按钮挨在一起，同一行', () => {
    const tt = t()
    const dl = tt.indexOf('downloadOne(o)')
    const del = tt.indexOf('purgeOne(o)')
    assert.ok(dl > 0 && del > 0, '两个入口都要在模板里')
    // 「删除前唯一的退路」—— 离太远没人会先看
    assert.ok(Math.abs(dl - del) < 900, '下载与删除应当相邻')
  })

  // 一个 20 分钟前、还没到年龄下限的对象恰恰最该让人先下来看看：
  // 它可能是正在上传的，也可能是垃圾。这两种情况都需要文件本身在手。
  test('下载按钮不绑定 deletable', () => {
    const tt = t()
    const at = tt.indexOf('@click="downloadOne(o)"')
    assert.ok(at > 0)
    const btn = tt.slice(tt.lastIndexOf('<button', at), at)
    assert.doesNotMatch(btn, /deletable/,
      '下载不该随 deletable 一起禁用 —— 未到年龄下限的对象最需要先看一眼')
  })

  test('下载按钮没有年龄/列举的前置条件', () => {
    const s2 = s()
    const at = s2.indexOf('async function downloadOne')
    const body = s2.slice(at, at + 900)
    assert.doesNotMatch(body, /o\.deletable|o\.ageMs/, '下载只看 key 能不能签')
    assert.match(body, /\/api\/manage\/bucket\/download'/, '调新端点')
    assert.match(body, /key: o\.key/, '把 key 传过去')
  })

  test('用 a[download] 而不是 window.open', () => {
    // window.open 在部分浏览器里把 attachment 开成新标签页而不是下载。
    const s2 = s()
    const at = s2.indexOf('async function downloadOne')
    const body = s2.slice(at, at + 1400)
    assert.match(body, /createElement\('a'\)/)
    assert.doesNotMatch(body, /window\.open/, '不用 window.open')
    assert.match(body, /a\.remove\(\)/, '合成元素用完即弃，不留在 DOM 里')
  })

  test('不可还原时如实告知，而不是静默', () => {
    const s2 = s()
    const at = s2.indexOf('async function downloadOne')
    const body = s2.slice(at, at + 1600)
    assert.match(body, /if \(!res\.filenameRecoverable\)/, '要检查这个标志')
    assert.match(body, /原文件名.*恢复|恢复.*原文件名/, '提示要说清名字恢复不了')
  })

  test('按钮图标都 import 了（vue-component-resolution 只管解析，不管语义）', () => {
    const s2 = s()
    // TrashIcon 是 import 里的最后一项，后面没有逗号 —— 所以不能断言 `TrashIcon,`。
    assert.match(s2, /ArrowDownTrayIcon\b/, '下载图标')
    assert.match(s2, /TrashIcon\b/, '删除图标')
    const tt = t()
    assert.match(tt, /<TrashIcon/, '删除按钮上真的用了图标')
    assert.match(tt, /<ArrowDownTrayIcon/, '下载按钮上真的用了图标')
  })

  test('按钮有 aria 之外的可见文字（图标不是唯一的可访问名）', () => {
    const tt = t()
    assert.match(tt, /<TrashIcon[\s\S]*?\/>\s*\n?\s*\{\{ purgingKey/, '删除按钮图标旁有文字')
    assert.match(tt, /<ArrowDownTrayIcon[\s\S]*?\/>\s*\n?\s*\{\{ downloadingKey/, '下载按钮图标旁有文字')
  })

  test('提示里说清 uuid 形式恢复不了原名', () => {
    const s2 = s()
    const at = s2.indexOf('function downloadHint')
    const body = s2.slice(at, at + 400)
    assert.match(body, /uuid/, '提示要解释为什么名字可能恢复不了')
  })
})