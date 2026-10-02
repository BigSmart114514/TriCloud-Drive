// SFC 校验：用 @vue/compiler-sfc 把每个 .vue 的 script 和 template 都编一遍，
// 目的是在不做 nuxt build 的前提下，抓出模板/脚本的语法错误。
// 用法: node /tmp/opencode/sfc-check.mjs [dir ...]   默认扫 app/
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['app']

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.nuxt' || e === '.output' || e === 'dist') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.vue')) yield p
  }
}

let files = 0
const problems = []

for (const root of roots) {
  for (const file of walk(root)) {
    files++
    const rel = relative(process.cwd(), file)
    const src = readFileSync(file, 'utf8')
    const id = rel
    let desc
    try {
      desc = parse(src, { filename: file })
    } catch (e) {
      problems.push(`${rel}: SFC 解析失败: ${e.message}`)
      continue
    }
    const { descriptor, errors } = desc
    if (errors?.length) {
      for (const e of errors) problems.push(`${rel}: parse: ${e.message ?? e}`)
    }

    // script / script setup
    if (descriptor.script || descriptor.scriptSetup) {
      try {
        compileScript(descriptor, { id })
      } catch (e) {
        problems.push(`${rel}: script: ${e.message.split('\n')[0]}`)
      }
    }

    // template —— expression 里的未定义标识符编译期抓不到，这里只抓语法
    if (descriptor.template) {
      const r = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id,
        compilerOptions: { expressionPlugins: ['typescript'] },
      })
      for (const e of r.errors ?? []) {
        const msg = typeof e === 'string' ? e : (e.message ?? String(e))
        problems.push(`${rel}: template: ${msg.split('\n')[0]}`)
      }
    }
  }
}

console.log(`扫了 ${files} 个 .vue`)
if (problems.length) {
  console.log(`\n✗ ${problems.length} 个问题:`)
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ 全部通过')
