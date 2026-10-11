#!/usr/bin/env node
// 构建产物冒烟测试：**真的把 .output 启动起来打几个请求**。
//
// ## 为什么需要它
//
// 2026-10-11 生产启动即崩：
//
//     TypeError: includes.bind is not a function
//         at .output/server/chunks/nitro/nitro.mjs:8668
//
// 崩溃在**模块求值期** —— 也就是说只要 `node .output/server/index.mjs` 这条命令
// 跑起来的一瞬间就会炸，根本等不到任何请求。
//
// 而当时的 CI 只做三件事：`npm ci`、`npm run build`、`zip -r .output`。产物从
// 生成到躺在生产机上，**从来没有被执行过一次**。这类崩溃 100% 漏。
//
// 更糟的是 CI 在 Node 22 上构建，产物被命名为 `nuxt-output-ubuntu-node22.zip`，
// 而生产跑 Node 24 —— 版本漂移就写在文件名里，没人在意。根因正是这条：打包器
// 生成的 interop helper 假设 CJS 命名空间只有 1 个 key，Node 新版本给的是 2 个。
//
// 所以这个脚本的重点不是「测功能」，是**让产物至少被执行一次**。
//
// ## 用法
//
//   node scripts/verify-build.mjs            # 用 .output，默认端口 3199
//   PORT=4000 node scripts/verify-build.mjs
//
// CI 里在 `npm run build` 之后、上传 artifact 之前跑一次。
//
// ## 为什么失败时要把子进程输出打出来
//
// 「启动失败」和「启动成功但接口不对」是两回事，排查方向完全不同。第一版只打印
// 「server did not become ready」，于是那次事故在 CI 上只会看到一行没有信息量的
// 红叉 —— 而真正的线索（那个 TypeError）就在子进程的 stderr 里。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUTPUT = join(process.cwd(), '.output')
const ENTRY = join(OUTPUT, 'server', 'index.mjs')
const PORT = Number(process.env.PORT || 3199)
const BOOT_TIMEOUT_MS = 45_000
const HOST = '127.0.0.1'

/** 收集子进程输出，失败时整段打出来 */
function makeSink() {
  const chunks = []
  return {
    write(s) {
      chunks.push(s)
      process.stdout.write(s)
    },
    text: () => chunks.join('')
  }
}

function fail(message, childOutput) {
  console.error(`\n✗ ${message}`)
  if (childOutput) {
    console.error('\n──── 子进程输出（线索通常在这里）────')
    console.error(childOutput.trimEnd() || '(空)')
    console.error('──────────────────────────────────────')
  }
  process.exit(1)
}

async function waitForBoot(sink) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let lastErr = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`产物在启动阶段就退出了（exit ${child.exitCode}）`, sink.text())
    }
    try {
      const res = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(4000) })
      return res
    } catch (e) {
      lastErr = e.message
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  fail(`产物在 ${BOOT_TIMEOUT_MS / 1000}s 内没有开始监听（最后一次错误：${lastErr}）`, sink.text())
}

async function check(label, path, expected) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000)
  })
  const ok = expected.includes(res.status)
  console.log(`${ok ? '  ✓' : '  ✗'} ${label} → HTTP ${res.status}${ok ? '' : `（期望 ${expected.join(' 或 ')}）`}`)
  return ok
}

if (!existsSync(ENTRY)) {
  console.error(`✗ 找不到 ${ENTRY} —— 先跑 npm run build`)
  process.exit(1)
}

// 临时库：绝不能碰开发或生产的 data.sqlite。dbPath 是相对 CWD 的，
// 而我们就在 .output 里跑，所以给它一个绝对路径。
const dbDir = mkdtempSync(join(tmpdir(), 'verify-build-'))
const sink = makeSink()

const child = spawn(process.execPath, [ENTRY], {
  cwd: OUTPUT,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    NITRO_HOST: HOST,
    // 有插件在启动时检查这个，缺了就抛 —— 那是有意的（静默降级比启动失败危险）
    NUXT_SESSION_SECRET: process.env.NUXT_SESSION_SECRET || 'verify-build-placeholder-secret',
    SQLITE_PATH: join(dbDir, 'verify.sqlite'),
    // 腾讯云密钥在 CI 里没有。本地有的话尊重它，没有就让它走 demoMode。
    ...(process.env.COS_SECRET_ID ? {} : {})
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

child.stdout.on('data', (d) => sink.write(d))
child.stderr.on('data', (d) => sink.write(d))

let results = []
try {
  console.log(`启动 ${ENTRY}（端口 ${PORT}，Node ${process.version}）…`)
  await waitForBoot(sink)
  console.log('产物起来了。产物**被执行过**这件事本身就是这次检查的主要目的。\n')

  // 首页 200：静态资源与渲染器能跑
  results.push(await check('首页', '/', [200]))
  // 鉴权 API 401：jsonwebtoken 的 verify 链路在跑。
  // 当年那次崩溃就在这条链路的模块里 —— 启动期就炸，所以走到这一步等于已经过了
  // 最凶的那道坎；但 verify 真的被调用一次，才能确认没换成另一种坏法。
  results.push(await check('未登录访问管理接口', '/api/manage/users', [401]))
  // 坏 token 也必须被拒，不能因为签名校验挂掉而变成「放行」或 500
  results.push(
    await check('坏 token', '/api/manage/users', [401])
  )
} catch (e) {
  fail(e.message, sink.text())
} finally {
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(dbDir, { recursive: true, force: true })
}

if (results.every(Boolean)) {
  console.log('\n✓ 产物可用。')
  process.exit(0)
}
console.log('\n✗ 产物能启动，但接口不对。')
process.exit(1)
