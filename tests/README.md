# 测试

用 Node 内置的 `node:test`，不引第三方框架（项目本来也没有测试依赖）。

```bash
npm test                      # 跑全部
node --test tests/share-badge.test.mjs    # 跑单个文件
```

Node ≥ 22.6（`.ts` 靠 `--experimental-strip-types` 直接 import，需要 22.18+ 才默认开启；
本仓库用的是 Node 22.23）。

## 覆盖范围

| 文件 | 测什么 | 依赖 |
|---|---|---|
| `share-badge.test.mjs` | `types/share.ts` 的纯函数：角标判定、三态归一、权限位掩码、分享链接 token | 无 |
| `resolve-access.test.mjs` | 分享权限解析的端到端行为：三种三态 × 预设 × 墙 | sqlite3 + 库副本 |
| `manifest-access.test.mjs` | 整包下载清单的权限过滤：属主快路径、访客过滤、skipped 计数 | sqlite3 + 库副本 |
| `share-link.test.mjs` | 分享链接的边界判定 + 增删（级联、UNIQUE、CHECK） | sqlite3 + 库副本 |
| `share-link-ui.test.mjs` | 链接在侧栏的呈现：失效原因、取消收藏、active 判定 | sqlite3 + 库副本 |
| `file-key-namespace.test.mjs` | `fileKey` 的属主命名空间校验：跨用户写路径被拒（安全修复的回归） | sqlite3 + 库副本 |
| `search.test.mjs` | 搜索的两种范围、`LIKE` 转义、路径折叠、接口权限边界、前端接线 | sqlite3 + 库副本 |
| `share-management.test.mjs` | 分享管理列表的判据/生效判定/摘要 + 批量三个动作 + 归属校验 + 祖先链 | sqlite3 + 库副本 |
| `quota-expiry.test.mjs` | 配额预占里的过期判据：四条路都判、空白值语义、文案分流 | sqlite3 + 库副本 |
| `sub-accounts.test.mjs` | 子账户配额链（自己上限 + 主账号池）+ 建号/改额度/改密的权限白名单 + 删主账号拦截 | sqlite3 + 库副本 |
| `server-time.test.mjs` | `server/utils/time.ts` 的时间推导（跨时区、时区偏移）、`isSqlDateTimeString` | 无 |
| `datetime-local.test.mjs` | `datetime-local` 与 ISO 字符串互转（编辑框回填） | 无 |

## helpers

| 文件 | 提供什么 |
|---|---|
| `sqlite-fixture.mjs` | 建库副本、造目录/文件/授权/链接、`reset()`。**所有集成测试共用** |
| `access-algorithm.mjs` | 分享权限算法的复刻（`combineWithAncestor` / `decideAncestor` / `resolveAccess` / `resolveFileAccessFrom` / `listDownloadableSubtree`） |

## 为什么算法是复刻而不是直接 import

`server/utils/db.ts`、`server/utils/share-link.ts`、`server/utils/search.ts`、
`server/utils/share-settings.ts` 与 `server/api/share/bulk.post.ts` 都依赖 Nuxt 的
自动导入（`createError` / `readBody` 等全局）、h3 和 `~~/` 路径别名，在
`node --test` 里跑不起来，所以把算法与 SQL 本体复制到
`helpers/access-algorithm.mjs` 与各测试文件里。

**代价：改了这些文件的算法必须同步改复刻处**，否则测试测的是旧逻辑。
每个函数上方都标了对应的源码位置（`db.ts:xxx` 之类），方便对照。

真实端到端验证（跑真实 dev server、浏览器里点）仍然是手工的，`node --test` 覆盖不到。

## 数据

集成测试把 `data.sqlite` **复制**到临时目录再操作，不碰开发库。
每个用例前 `reset()`，只清理自己造的 id ≥ 900 的数据。

夹具自己建 `share_links` 表与两个级联删除触发器（与 `schema.sql` / `db-migrate.ts`
一致），不依赖开发库是否已迁移过 —— 否则「有没有先跑过 dev server」会变成测试能否
运行的前置条件，报错还长得像业务 bug。
