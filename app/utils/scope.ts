// ~/utils/scope.ts
//
// 「以谁的身份操作」这两个参数（targetUserId / useAdmin）的注入样板。
//
// ## 为什么抽
//
// 四个 service（files / folders / move / copy）里每个方法都是这两行，
// 加两个 composable 各三到四处，一共 18 处：
//
//     if (targetUserId) params.targetUserId = targetUserId
//     if (useAdmin) params.useAdmin = 1
//
// 而 app/services/share.service.ts 里早就有 scopeParams() 是这件事的正确抽象
// —— 只是没人用它。这个文件把那份推广到其余各处。
//
// ## 三个必须保持原样的细节
//
// 1. **useAdmin 传 1 不是 true**。服务端 readBool 认 1，而这几个接口历史上
//    收的就是 1；改成 true 要挨个确认服务端分支，收益为零风险未知。
// 2. **判断用真值而非 !== null**。也就是 targetUserId = 0 与 undefined 都不传。
//    0 本来就不是合法 id（「根」用 null 或 'root'），所以真值判断是对的。
// 3. **空值不传，而不是传 undefined**。序列化时 undefined 会被丢，但显式不设
//    更清楚，也省得服务端多一个 readBool 分支。
import type { Ref } from 'vue'

export interface ScopeOptions {
  targetUserId?: number | null | undefined
  useAdmin?: boolean | null | undefined
}

/**
 * 要往 params/body 上加字段，所以它的类型必须允许写入。
 *
 * 写 `T extends Record<string, any>` 不够 —— 那样 T 上**读**得到任意属性、
 * **写**却报错（TS 认为 Record 的已知属性是 unknown 的那些）。所以显式加上
 * 这两个可选字段。调用方传进来的对象本来就没有这两个字段，全可选。
 */
type Scopeable = Record<string, any> & {
  targetUserId?: number
  useAdmin?: number
}

/**
 * 只要「管理视角」那两个参数，不带 target 本身。给**没有具体分享目标**的调用用 ——
 * 目前只有分享候选人搜索（搜「有哪些人可授权」，手里只有关键词）。
 *
 * ## 为什么单独一个，而不是直接 withScope
 *
 * 两个原因，都是实测出来的：
 *
 * 1. **搜索接口不看 targetType / targetId。** withScope 是往调用方给好的
 *    params/body 上加字段，而搜索的 params 里根本没有 target 的位置。
 *
 * 2. **它的判据必须与 withScope 不同 —— 而且这个不同是承重的。**
 *    withScope 两个条件独立判（各自真就各自发），那是对的：files/folders
 *    那些接口本来就允许「改了别人的视角但没带 targetUserId」这种组合。
 *
 *    而搜索不行。服务端 resolveIdentity 只认 useAdmin：
 *      useAdmin 缺省为假      → adminMode 假 → 排除集 { 我 } → 管理员搜不到自己
 *      useAdmin 真、target 缺省 → targetUserId = 我，而 adminMode 真
 *                             → 排除集 { 我 }（因为 target===me）→ 一样搜不到
 *
 *    两个都要有才有效。所以这里用合取，把「只发一个」这个静默退化的组合
 *    从源头去掉，而不是发出去让服务端在下游补。
 *
 * ## 为什么会漏
 *
 * share.service 里 candidates 的签名本来是 `(keyword, excludeIds)` —— 压根没有
 * target，没有东西可以喂给它，于是手写 params 时把这两个漏了。别的调用都吃
 * scope，所以只有这一个坏掉：分享开关能改、能加别人、能删链接，就是搜不到人。
 */
export function adminScope(scope: ScopeOptions): { useAdmin?: boolean; targetUserId?: number } {
  if (scope.useAdmin && scope.targetUserId) {
    return { useAdmin: true, targetUserId: scope.targetUserId }
  }
  return {}
}

/** 已取到值的 scope。给 service 用。 */
export function withScope<T extends Scopeable>(params: T, scope: ScopeOptions): T {
  if (scope.targetUserId) params.targetUserId = scope.targetUserId
  // 传 1 而不是 true：与这些接口一直以来的约定一致（服务端 readBool 认 1）
  if (scope.useAdmin) params.useAdmin = 1
  return params
}

/** scope 的值还在 ref 里。给 composable 用。 */
export function withScopeRef<T extends Scopeable>(
  params: T,
  targetUserId: Ref<number | null | undefined> | null | undefined,
  useAdmin: Ref<boolean | null | undefined> | null | undefined
): T {
  if (targetUserId?.value) params.targetUserId = targetUserId.value
  if (useAdmin?.value) params.useAdmin = 1
  return params
}
