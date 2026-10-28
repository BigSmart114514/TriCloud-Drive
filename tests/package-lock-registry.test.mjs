// package-lock 里的下载地址必须公共可达。
//
// ## 为什么要钉这个
//
// 本机（腾讯云服务器）的 npm 配的是内网镜像 mirrors.tencentyun.com。这个域名
// 在服务器上能解析，于是 package-lock.json 里混进了 48 条内网 tarball 地址。
// GitHub Actions 的 runner 解析不到它，`npm ci` 直接 ENOTFOUND；Windows 上
// 还会表现成 npm 自己的 "Exit handler never called!"，看起来像 npm 崩了，
// 实际只是地址不可达。
//
// 这里把「resolved 只能指向公共 registry」钉死，避免下一次在内网机器上
// `npm install` 又把地址写回去。约束的是 lockfile，不是本机 registry 配置 ——
// 本机仍然可以用镜像，只是不能把镜像地址带进提交。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const lockText = readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')
const lock = JSON.parse(lockText)
const entries = Object.entries(lock.packages ?? {}).filter(([, pkg]) => pkg?.resolved)

const PUBLIC_PREFIX = 'https://registry.npmjs.org/'

describe('package-lock 的下载地址', () => {
  test('每一条 resolved 都指向公共 npm registry', () => {
    const bad = entries.filter(([, pkg]) => !pkg.resolved.startsWith(PUBLIC_PREFIX))
    assert.equal(
      bad.length,
      0,
      `有 ${bad.length} 条地址不在 ${PUBLIC_PREFIX}，GitHub Actions 可能解析不到：\n` +
        bad.slice(0, 8).map(([name, pkg]) => `${name || '(root)'}: ${pkg.resolved}`).join('\n')
    )
  })

  test('没有腾讯云内网镜像域名', () => {
    for (const host of ['mirrors.tencentyun.com', 'mirrors.cloud.tencent.com']) {
      assert.ok(!lockText.includes(host), `package-lock.json 里还有内网镜像 ${host}`)
    }
  })

  test('没有明文 http 的 tarball 地址', () => {
    const insecure = entries.filter(([, pkg]) => pkg.resolved.startsWith('http://'))
    assert.equal(
      insecure.length,
      0,
      `有 ${insecure.length} 条明文 http 地址：\n` +
        insecure.slice(0, 5).map(([name, pkg]) => `${name}: ${pkg.resolved}`).join('\n')
    )
  })
})
