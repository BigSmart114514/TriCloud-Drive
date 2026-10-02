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
