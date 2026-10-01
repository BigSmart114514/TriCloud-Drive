/**
 * 收藏的分享链接：存在浏览器 localStorage 里，不入库。
 *
 * 为什么是「收藏」而不是「服务端记录」：拿到链接的人多半没有账号，
 * 而链接本身就是凭据 —— 服务端记一份「谁收藏了什么」只会凭空多出一张
 * token 泄漏面（收藏列表就是一份 token 清单）。所以这个功能整个在客户端。
 *
 * 存什么：只存 token 本身。名字**不缓存** —— 它随时会变（属主改名），
 * 而且改一次就要多一次校验请求；侧栏显示的名字由 resolve 接口现给。
 */
import { normalizeShareLink, SHARE_LINK_TOKEN_BYTES } from '~~/types/share'
import { ShareService } from '~/services/share.service'

export const SHARE_LINKS_STORAGE_KEY = 'tricloud.share-links'

/**
 * 上限。localStorage 配额有限，而 token 本身有 32 位随机熵 —— 真有人手工攒
 * 上万条的话，那不是正常使用，是别的东西。超了就丢最旧的（FIFO）。
 */
export const SHARE_LINKS_MAX = 50

/** 本地存储里可能存在的脏数据一律在这里挡掉 */
function sanitizeToken(value: any): string | null {
  return normalizeShareLink(typeof value === 'string' ? value : null)
}

const readRaw = (): string[] => {
  if (!import.meta.client) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SHARE_LINKS_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    // 去重 + 按存储顺序保留（第一个出现的位置），顺手挡掉非法形状
    const out: string[] = []
    for (const item of parsed) {
      const token = sanitizeToken(item)
      if (token && !out.includes(token)) out.push(token)
    }
    return out
  } catch {
    return []
  }
}

const writeRaw = (tokens: string[]) => {
  if (!import.meta.client) return
  try {
    window.localStorage.setItem(SHARE_LINKS_STORAGE_KEY, JSON.stringify(tokens))
  } catch {
    // 隐私模式 / 配额满 / 被禁用。忽略：功能降级成「这次收藏不记住」，
    // 不该因此报错打乱用户的操作
  }
}

export const useShareLinks = () => {
  /**
   * 用 useState 而不是普通 ref：首页侧栏和链接视图可能挂在不同组件里，
   * 需要同一份。SSR 阶段读不到 localStorage，初始恒为空，
   * 由 hydrateLinks() 在客户端补上。
   */
  const tokens = useState<string[]>('share-links', () => [])

  const hydrateLinks = () => {
    tokens.value = readRaw()
  }

  /**
   * 加一条。已收藏则原样返回 false —— 重复收藏不该在列表里出现两行。
   *
   * **「是否已收藏」判断读的是 localStorage，不是 tokens。**
   *
   * tokens 是 useState，会被 SSR 序列化进 payload。而 writeRaw 只在客户端写盘 ——
   * 于是服务端跑过一次 addLink 之后：state 里有、盘上没有；客户端 hydration
   * 拿到那个 state，判断「已收藏」→ 不写盘；onMounted 的 hydrateLinks 又用空的
   * 盘覆盖 state → token 消失。结果是 localStorage 永远空、侧栏永远空。
   *
   * 拿盘当唯一事实来源，这类不一致就没有存在的空间：盘上没有就是没有。
   */
  const addLink = (raw: any): boolean => {
    const token = sanitizeToken(raw)
    if (!token) return false
    const stored = readRaw()
    if (stored.includes(token)) {
      // 盘上已有。让 state 跟上（SSR payload 可能带了旧值），但不重复写盘
      tokens.value = stored
      return false
    }
    const next = [...stored, token]
    // 超上限丢最旧的：收藏列表是「最近用过的链接」，不是归档
    while (next.length > SHARE_LINKS_MAX) next.shift()
    tokens.value = next
    writeRaw(next)
    return true
  }

  const removeLink = (raw: any) => {
    const token = sanitizeToken(raw)
    if (!token) return
    // 同 addLink：以盘为准，不拿可能被 SSR 污染的 state 去算
    const stored = readRaw()
    const next = stored.filter((t) => t !== token)
    // 没变化就别写：避免无谓的 localStorage 写入（每次点「取消收藏」都写一次没意义）
    if (next.length === stored.length) {
      tokens.value = next
      return
    }
    tokens.value = next
    writeRaw(next)
  }

  const hasLink = (raw: any) => {
    const token = sanitizeToken(raw)
    return !!token && tokens.value.includes(token)
  }

  /**
   * 校验一条链接，并**按需**把它从收藏里删掉。
   *
   * ## 唯一的删除依据是 `valid === false`
   *
   * 服务端把「无效」放在返回值里（无效也返回 200），所以这里只认这一个字段。
   *
   * **刻意不看状态码**。之前那版是「statusCode === 404 就删」，而 404 能来自的地方
   * 太多了：网关、代理、上层兜底、一次数据库抖动 —— 只要响应是 404，前端就会
   * 清空用户的收藏，而服务端其实什么都没说过。删除不可逆，这种误删是最坏的一种。
   *
   * 判定表：
   *
   *   valid=true  active=true   → 打开
   *   valid=true  active=false  → **保留**。链接和目标都还在，只是继承态下上游
   *     没人拍板（或被「不分享」的墙挡住）。属主随时可能把上游改成「分享」，
   *     那时候它就好了 —— 这时候删是破坏性的、且不可恢复。
   *   valid=false               → **删**。token 从没存在 / 已被撤销，或目标已删。
   *     这两种都不可恢复，留着只会一直报错。
   *   抛异常（5xx / 超时 / 断网 / 任何非预期）→ **保留**。这次没问成，
   *     不等于链接坏了。
   *
   * 返回值给 UI 用（名字、是否可用）。异常时返回 null，调用方据此显示
   * 「暂时无法校验」而不是「链接无效」—— 这两件事在界面上必须区分开。
   */
  const verifyLink = async (raw: any) => {
    const token = sanitizeToken(raw)
    if (!token) return null
    let res: Awaited<ReturnType<typeof ShareService.resolveLink>>
    try {
      res = await ShareService.resolveLink(token)
    } catch {
      // 任何异常都不删 —— 这次没问成不等于链接坏了。见上面的判定表。
      return null
    }

    // 只认这一个字段。服务端明确说了无效才删。
    if (res?.valid === false) {
      removeLink(token)
      return null
    }

    return res
  }

  return {
    tokens,
    hydrateLinks,
    addLink,
    removeLink,
    hasLink,
    verifyLink,
    SHARE_LINKS_MAX,
    SHARE_LINK_TOKEN_BYTES
  }
}