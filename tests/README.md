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
| `share-badge.test.mjs` | `types/share.ts` 的纯函数：角标判定、三态归一、权限位掩码 | 无 |
| `resolve-access.test.mjs` | 分享权限解析的端到端行为：三种三态 × 预设 × 墙 | sqlite3 + 库副本 |

## 为什么 `resolve-access` 是复刻而不是直接 import

`server/utils/db.ts` 依赖 Nuxt 的自动导入（`createError` 等全局）和 sqlite3 封装，
在 `node --test` 里跑不起来，所以测试里复刻了算法本体（`combineWithAncestor` /
`decideAncestor` / `resolveAccess` 的 SQL）。

**代价：改了 `db.ts` 的算法必须同步改这里**，否则测试测的是旧逻辑。测试里每个
函数上方都标了对应的源码位置（`db.ts:256` 之类），方便对照。

真正的端到端验证（跑真实 dev server）仍然是手工的，靠 `node --test` 覆盖不到。

## 数据

`resolve-access.test.mjs` 会把 `data.sqlite` **复制**到临时目录再操作，不碰开发库。
测试内会 `DELETE FROM folders WHERE id >= 900` 之类，只清理自己造的 id ≥ 900 的数据。
