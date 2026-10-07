// 管理页的 composable 引入方式。
//
// ## 实际发生过什么
//
// /manage/bucket 渲染时抛 SSR 500：`useAuth is not defined`。那行是
// `const { user, fetchUser } = useAuth()`，页面结构与 manage/files.vue 完全一样，
// 只差一个显式 import —— files.vue 有，bucket.vue 没有。
//
// ## 说不清的部分
//
// `useAuth` **确实在自动导入清单里**（.nuxt/imports.d.ts:36），所以理论上该被
// 自动注入。而我复现不出那个 500：未登录会在 auth.global.ts 就被弹走，页面
// 根本不渲染，拿不到触发它的会话。
//
// 全项目另有 8 个文件靠自动导入用 useAuth（app.vue、AppNavbar、FileBrowser、
// auth.global.ts、login、register、accounts、change-password），它们都正常。
//
// 所以这里不是「自动导入坏了」，而是「这一个页面没拿到注入」而原因未查明。
// 既然没查清，就不要赌 —— 管理页那一个 500 的代价是超管正在操作的东西全丢。
//
// ## 为什么只管 manage/ 下面这几个
//
// 把那 8 个文件全改成显式 import 更彻底，但那是 8 个正在服役的核心页面的无谓
// 改动，风险与收益不成比例。而 manage/ 下三个页面里有两个已经因为这个原因出过
// 事，把它们钉住是有实据的。范围写在这里，免得后来的人以为这是全项目约定。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const MANAGE_PAGES = [
  'app/pages/manage/files.vue',
  'app/pages/manage/user.vue',
  'app/pages/manage/bucket.vue'
]

function scriptOf(p) {
  const { descriptor, errors } = parse(readFileSync(join(root, p), 'utf8'), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错`)
  return descriptor.scriptSetup?.content ?? ''
}

describe('管理页显式 import useAuth，不靠自动导入', () => {
  for (const p of MANAGE_PAGES) {
    test(`${p} 显式 import useAuth`, () => {
      const s = scriptOf(p)
      // 必须用 `^\s*` 锚到行首。
      //
      // 不锚的话，「被注释掉的 import」照样匹配 —— 而那正是合并/回退搞砸之后
      // 最常见的样子：代码在、注释在、import 不在了。变异扫描里那条
      // 「把 import 前面加 //」就是这么溜过去的。
      assert.match(
        s,
        /^\s*import \{ useAuth \} from '~\/composables\/useAuth'/m,
        `${p} 必须显式 import useAuth —— 自动导入注入失败过一次，代价是 SSR 500`
      )
    })

    test(`${p} 真的用到了 useAuth（否则上一条是空断言）`, () => {
      const s = scriptOf(p)
      assert.match(s, /\buseAuth\s*\(/, `${p} 没有调用 useAuth —— 那 import 就是多余的`)
    })
  }

  test('三个页面一个都没漏（防止路径写错扫到 0 个而全绿）', () => {
    for (const p of MANAGE_PAGES) {
      const s = scriptOf(p)
      assert.ok(
        /\buseAuth\s*\(/.test(s),
        `${p} 不在预期内 —— 页面结构若变了，这条要跟着改，否则会悄悄扫 0 个`
      )
    }
    assert.equal(MANAGE_PAGES.length, 3)
  })
})

describe('这条约定的范围写在文件里，不假装是全项目约定', () => {
  test('其它页面仍靠自动导入 —— 明确记录，免得日后以为漏了', () => {
    // 显式点名三个仍依赖自动导入的文件。它们是能工作的，所以不在这轮改动里，
    // 但如果将来也改成显式 import，这里要跟着更新（否则这条会开始撒谎）。
    const relyingOnAutoImport = [
      'app/app.vue',
      'app/components/AppNavbar.vue',
      'app/middleware/auth.global.ts',
      'app/pages/login.vue'
    ]
    for (const p of relyingOnAutoImport) {
      const s = readFileSync(join(root, p), 'utf8')
      if (/\buseAuth\s*\(/.test(s)) {
        assert.doesNotMatch(
          s,
          /^\s*import \{[^}]*\buseAuth\b[^}]*\} from/m,
          `${p} 已经改成显式 import 了 —— 请更新本测试里的清单，否则「靠自动导入」这句描述就不准了`
        )
      }
    }
  })
})