<template>
  <!--
    首页。三个分支，互斥：

      已登录 + ?share_link  → 侧栏（链接 + 人）+ 链接视图
      已登录                → 侧栏（链接 + 人）+ 自己的/选人的文件
      未登录 + ?share_link  → 链接视图（只读 + 下载），不套 max-w 容器
      未登录                → 欢迎页

    改造前这里是 `v-if="isLoggedIn"` / `v-else`，而 v-else 分支内部又是
    `v-if="!isLoggedIn"`（欢迎页）/ `v-else`（FileBrowser）—— 内层那个 FileBrowser
    永远不成立，是一段死代码。现在按身份 × 有无链接展开成四个真实分支。
  -->
  <div v-if="showShell" class="flex h-[100dvh] flex-col overflow-hidden bg-gray-50">
    <AppNavbar fluid>
      <template #extra>
        <NuxtLink
          to="/services/change-password"
          class="text-gray-700 hover:text-gray-900 rounded-md text-sm font-medium p-2 sm:px-3 sm:py-2 flex items-center"
          aria-label="修改密码"
          title="修改密码"
        >
          <KeyIcon class="h-5 w-5" />
          <span class="hidden sm:inline ml-2">修改密码</span>
        </NuxtLink>
      </template>
    </AppNavbar>

    <div class="flex min-h-0 flex-1">
      <SidePanelLayout v-model:open="drawerOpen" :aria-label="sidebarAriaLabel">
        <template #sidebar>
          <!--
            侧栏分两段，**链接一链接一行、不与用户合并**。
            两段各自选中，用 selectedKind 区分而不是靠 id 猜 ——
            userId 是数字、token 是 32 位 hex，靠形状区分迟早出事
            （token 全数字的话更糟）。
          -->
          <div class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            <ShareLinkList
              v-if="isLoggedIn"
              :links="linkEntries"
              :loading="checkingLinks"
              :selected-token="selectedKind === 'link' ? selectedToken : null"
              @select="onSelectLink"
              @remove="onRemoveLink"
            />

            <ManageUserList
              v-if="isLoggedIn"
              v-model="userSearch"
              :users="[selfEntry, ...people] as any"
              :selected-id="selectedKind === 'user' ? (viewingOthers ? selectedUserId : myId) : null"
              :loading="loadingPeople"
              @select="onSelectPerson"
              @search="loadPeople"
              @refresh="loadPeople"
            />
          </div>
        </template>

        <template #toolbar>
          <div class="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
            <button
              type="button"
              class="-ml-1 rounded-md p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 lg:hidden"
              aria-label="打开侧栏"
              title="分享链接与用户"
              @click="drawerOpen = true"
            >
              <Bars3Icon class="h-5 w-5" />
            </button>

            <div class="min-w-0 flex-1">
              <h1 class="truncate text-base font-semibold text-gray-900">{{ panelTitle }}</h1>
              <p v-if="panelSubtitle" class="truncate text-xs text-gray-500">{{ panelSubtitle }}</p>
            </div>
          </div>
        </template>

        <div class="h-full bg-white">
          <FileBrowser
            :key="browserKey"
            :variant="viewingOthers ? 'shared' : 'own'"
            :link="activeLink"
            :target-user-id="viewingOthers ? selectedUserId : null"
            fill
            ref="fileListRef"
            @folder-change="onFolderChange"
            @location-change="onLocationChange"
          />
        </div>
      </SidePanelLayout>
    </div>
  </div>

  <!-- 未登录：欢迎页。有链接则直接进链接视图，不给欢迎页 -->
  <div v-else-if="activeLink" class="flex h-[100dvh] flex-col overflow-hidden bg-gray-50">
    <AppNavbar />
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-semibold text-gray-900">{{ panelTitle }}</h1>
          <p class="truncate text-xs text-gray-500">{{ panelSubtitle }}</p>
        </div>
      </div>
      <div class="min-h-0 flex-1 bg-white">
        <FileBrowser
          :key="browserKey"
          variant="own"
          :link="activeLink"
          fill
          ref="fileListRef"
          @folder-change="onFolderChange"
          @location-change="onLocationChange"
        />
      </div>
    </div>
  </div>

  <div v-else class="min-h-screen bg-gray-50">
    <AppNavbar>
      <template #extra>
        <NuxtLink
          to="/services/change-password"
          class="text-gray-700 hover:text-gray-900 rounded-md text-sm font-medium p-2 sm:px-3 sm:py-2 flex items-center"
          aria-label="修改密码"
          title="修改密码"
        >
          <KeyIcon class="h-5 w-5" />
          <span class="hidden sm:inline ml-2">修改密码</span>
        </NuxtLink>
      </template>
    </AppNavbar>

    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <div class="px-4 py-6 sm:px-0">
        <div class="text-center">
          <h2 class="text-3xl font-extrabold text-gray-900 sm:text-4xl">欢迎来到 TriCloud Drive</h2>
          <p class="mt-4 text-lg text-gray-600">不安全、不可靠的云存储解决方案（bushi</p>
          <div class="mt-6">
            <NuxtLink
              to="/register"
              class="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
            >
              开始使用
            </NuxtLink>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KeyIcon, Bars3Icon } from '@heroicons/vue/24/outline'
import FileBrowser from '~/components/FileBrowser.vue'
import SidePanelLayout from '~/components/SidePanelLayout.vue'
import ManageUserList from '~/components/ManageUserList.vue'
import ShareLinkList from '~/components/ShareLinkList.vue'
import { useAuth } from '~/composables/useAuth'
import { useShareLinks } from '~/composables/useShareLinks'
import { notify, notifyError } from '~/utils/notify'
import { normalizeShareLink, SHARE_LINK_QUERY_KEY } from '~~/types/share'

const { user, isLoggedIn } = useAuth()
const fileListRef = ref()
const currentFolderId = ref<number | null>(null)

const onFolderChange = (id: number | null) => {
  currentFolderId.value = id
}

// 标签页标题跟着「当前打开的东西」走：预览文件时是文件名，进目录是目录名。
const pageTitle = ref('我的文件')
useHead({ title: pageTitle })

const onLocationChange = (name: string) => {
  pageTitle.value = name
}

type Person = {
  id: number
  username?: string | null
  email?: string | null
  self?: boolean
  relation?: 'granted' | 'public' | 'both' | null
  maxPermission?: number
}

/**
 * 侧栏 = 「有内容是我能看的」的人，数据源 /api/share/people。
 * 普通功能：不判断 isAdmin，管理员和普通用户拿到同一份数据；
 * 选中某人后 FileBrowser 也不传 useAdmin，服务端按分享权限判。
 *
 * 这个列表**只看按人授权和公开**（people.get.ts 的 SQL 里没有 share_links），
 * 所以「用户入口下看不到只能通过链接访问的内容」在服务端天然成立。
 */
const people = ref<Person[]>([])
const loadingPeople = ref(false)
const userSearch = ref('')
/**
 * 侧栏选中态用「种类 + 值」两段表达，而不是一个 id。
 *
 * 不这么做的原因：token 是 32 位 hex，理论上可能全是数字（虽然概率极低），
 * 与 userId 撞形状；更实际的是「选中的是谁/哪条链接」这件事本身需要
 * 区分 —— 同一个目录既可能被授权给某人、又可能挂了链接，
 * 那是**两个独立的侧栏入口**，不能合成一行。
 */
const selectedKind = ref<'user' | 'link' | null>(null)
/** null = 我的文件 */
const selectedUserId = ref<number | null>(null)
const selectedToken = ref<string | null>(null)
const drawerOpen = ref(false)

const selected = computed(() => people.value.find((p) => p.id === selectedUserId.value) || null)

const myId = computed(() => {
  const u = user.value as any
  return u ? Number(u.id) : null
})
// 侧栏首行固定是「我的文件」。接口已排除自己，这里再显式排一个，
// 语义比「在列表里找自己」清楚。
const selfEntry = computed<Person>(() => ({
  id: myId.value ?? 0,
  username: (user.value as any)?.username ?? null,
  email: (user.value as any)?.email ?? null,
  self: true
}))

/* ---------------- 分享链接 ---------------- */

const route = useRoute()
const router = useRouter()
const { tokens, hydrateLinks, addLink, removeLink, verifyLink } = useShareLinks()

/**
 * URL 上的 ?share_link=。
 *
 * 带它进首页就把 token 收进本地收藏 —— 这是「点开别人发来的链接之后
 * 侧栏里能继续找到它」的唯一入口。形状不合法（长度/字符不对）直接忽略：
 * 那是手敲错的，不是链接坏了，不必给提示。
 */
const urlLink = computed(() => normalizeShareLink(route.query[SHARE_LINK_QUERY_KEY]))
/** 从侧栏点开的那条。两者取其一：URL 上的优先（用户刚点的那个） */
const activeLink = computed(() => urlLink.value || selectedToken.value)

/**
 * 当前数据源是不是「别人的东西」。决定 FileBrowser 的 variant。
 *
 * **必须与 selectedKind 分开**：那个表达「侧栏选中哪一段」，用来控制高亮；
 * 这个表达「数据源不是我的」。两者会分叉 —— 点侧栏首行「我的文件」时
 * selectedUserId 变 null（确实是自己的文件），但 selectedKind 仍是 'user'
 * （首行要保持高亮）。
 *
 * 混用会出的 bug：variant 传成 'shared' → isOwn 为 false →
 * `showShareBadge = isOwn && !linkMode` 为 false → **角标与红点全不渲染**。
 * 而且只在「先点过别人、再点回自己」之后才发作：首屏 selectedKind 是 null，
 * 所以第一次进来是对的，问题藏得很深。
 */
const viewingOthers = computed(() => !!activeLink.value || selected.value !== null)

/**
 * 侧栏里每条链接的展示信息。
 *
 * 名字**不缓存**（见 useShareLinks 的注释），每次进页面验一次。
 * `active: false` 的行保留在列表里并标出来，不删 —— 属主把上游改成
 * 「分享」之后它就好了，删掉是破坏性的。
 */
type LinkEntry = {
  token: string
  name: string
  active: boolean
  reason: string | null
  checking: boolean
}
const linkEntries = ref<LinkEntry[]>([])
const checkingLinks = ref(false)

/** 并发校验一整批。逐个 await 会让侧栏空白很久 */
async function refreshLinks() {
  const list = [...tokens.value]
  if (!list.length) {
    linkEntries.value = []
    return
  }
  checkingLinks.value = true
  try {
    const results = await Promise.all(
      list.map(async (token) => {
        // 先塞一条占位，避免整批 await 期间侧栏什么都不显示
        linkEntries.value = upsertEntry(linkEntries.value, {
          token, name: '', active: true, reason: null, checking: true
        })
        const res = await verifyLink(token)
        return { token, res }
      })
    )
    for (const { token, res } of results) {
      if (!res) {
        // res 为 null 有两种来源，两种都要保留这一行：
        //   1. valid=false → verifyLink 已把它从本地存储删了（它内部做的），
        //      末尾那句「按 tokens 收敛」负责从展示列表去掉
        //   2. 抛异常（5xx / 超时 / 断网）→ **没删**存储，标成「暂时无法校验」，
        //      让用户知道这条还在、只是这次没问成，而不是以为它坏了
        linkEntries.value = linkEntries.value.map((e) =>
          e.token === token ? { ...e, checking: false, name: e.name || '暂时无法校验', reason: null } : e
        )
        continue
      }
      linkEntries.value = upsertEntry(linkEntries.value, {
        token,
        name: res.name || '未命名',
        active: res.active,
        reason: res.active ? null : res.reason,
        checking: false
      })
    }
    /**
     * 按 tokens 收敛一次。这一步**不是**误删通路，而是补一个竞态：
     *
     *   refreshLinks 开头的 list 是快照。用户在请求返回前点了「取消收藏」，
     *   tokens 里已经没有那条了，但上面的循环仍会把它 upsert 回 linkEntries
     *   （那份快照里有）。这一句把它清掉。
     *
     * 它也是「服务端说 valid=false」那条的唯一出口 —— verifyLink 内部已经
     * 把 token 从存储删了，这里负责让界面跟上。
     */
    linkEntries.value = linkEntries.value.filter((e) => tokens.value.includes(e.token))
  } catch (e) {
    // 整批失败（比如断网）：不删任何东西，各行标「未校验」
    linkEntries.value = linkEntries.value.map((e) => ({ ...e, checking: false }))
    notifyError(e, '无法校验分享链接')
  } finally {
    checkingLinks.value = false
  }
}

const upsertEntry = (list: LinkEntry[], entry: LinkEntry): LinkEntry[] => {
  const i = list.findIndex((e) => e.token === entry.token)
  if (i === -1) return [...list, entry]
  const next = [...list]
  next[i] = entry
  return next
}

/** 取消收藏：只是从本地存储删，不动服务端（那条链接本身可能还有别人在用） */
/**
 * 取消收藏：只是从本地存储删，不动服务端（那条链接本身可能还有别人在用，
 * 撤销它得去 ShareDialog 里）。
 *
 * **必须同时改 `linkEntries`** —— 它才是列表渲染的数据源。原先只调 removeLink
 * （那改的是 `tokens`），两个状态不同步，界面不会重画，要刷新才看得到变化。
 * 同步删掉这一行即可，不需要重跑 refreshLinks（少一批请求，也不会让整段
 * 闪回「校验中」）。
 */
function onRemoveLink(token: string) {
  removeLink(token)
  linkEntries.value = linkEntries.value.filter((e) => e.token !== token)
  // 正在看的就是这一条时，退回自己的文件 —— 留着链接视图但侧栏没有它，
  // 用户会以为收藏还在
  if (activeLink.value === token) {
    selectedToken.value = null
    selectedKind.value = selectedKind.value === 'link' ? null : selectedKind.value
    const rest = { ...route.query }
    delete rest[SHARE_LINK_QUERY_KEY]
    router.replace({ query: rest })
  }
  notify('已从侧栏移除', 'success')
}

/** 点侧栏里的链接：切过去，顺手把它写进 URL（刷新后仍是这一条） */
function onSelectLink(token: string) {
  selectedKind.value = 'link'
  selectedToken.value = token
  selectedUserId.value = null
  drawerOpen.value = false
  router.replace({ query: { ...route.query, [SHARE_LINK_QUERY_KEY]: token } })
}

function onSelectPerson(p: { id: number }) {
  selectedKind.value = 'user'
  selectedUserId.value = Number(p.id) === myId.value ? null : Number(p.id)
  selectedToken.value = null
  drawerOpen.value = false
  // 从链接视图退回用户视图时清掉 URL 上的 token，
  // 否则刷新会又被拉回链接视角
  const rest = { ...route.query }
  delete rest[SHARE_LINK_QUERY_KEY]
  router.replace({ query: rest })
}

/* ---------------- 面板标题 ---------------- */

const showShell = computed(() => isLoggedIn.value || !!activeLink.value)
const sidebarAriaLabel = computed(() =>
  selectedKind.value === 'link' ? '分享链接' : '分享给我的人'
)

const panelTitle = computed(() => {
  if (activeLink.value) {
    const entry = linkEntries.value.find((e) => e.token === activeLink.value)
    return entry?.name ? `分享内容：${entry.name}` : '分享内容'
  }
  if (selected.value) return `${selected.value.username || selected.value.email} 的分享内容`
  return '我的文件'
})

const panelSubtitle = computed(() => {
  if (activeLink.value) {
    const entry = linkEntries.value.find((e) => e.token === activeLink.value)
    if (entry && !entry.active) return entry.reason || '这个分享链接当前不可用'
    // 说清这是链接视角：这里看到的条目与「分享给我的人」里的是两批东西。
    // 不提「额度记在属主账上」—— 那是在解释内部计费口径，用户真正关心的
    // 是「我会不会被扣」。答案已经含在「查看和下载」里：链接分支排他，
    // 登录也不多给权限，流量本来就不走访客的账。
    return '通过分享链接查看 · 查看和下载'
  }
  if (selected.value) return relationLabel(selected.value)
  return ''
})

/**
 * FileBrowser 的 key。切换数据源时整棵组件重建 ——
 * FileBrowser 内部持有浏览状态（currentFolderId / breadcrumbs），
 * 不重建的话会带着上一个视角的目录 id 去请求，必然 404。
 * 链接本身进 key：换一条链接 = 换一棵（别人的）树。
 */
const browserKey = computed(() => {
  if (activeLink.value) return `link-${activeLink.value}`
  if (selected.value) return `shared-${selected.value.id}`
  return 'own'
})

function relationLabel(p: Person) {
  if (p.relation === 'granted') return '授权给我'
  if (p.relation === 'public') return '公开'
  if (p.relation === 'both') return '授权 + 公开'
  return ''
}

async function loadPeople() {
  try {
    loadingPeople.value = true
    const headers = process.server ? useRequestHeaders(['cookie']) : undefined
    const res = await $fetch<{ people: Person[] }>('/api/share/people', {
      headers,
      credentials: 'include'
    })
    const q = userSearch.value.trim().toLowerCase()
    const list = res.people ?? []
    people.value = q
      ? list.filter(
          (p) =>
            (p.username || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q)
        )
      : list
  } catch {
    people.value = []
  } finally {
    loadingPeople.value = false
  }
}

/**
 * 收到 ?share_link= 就收藏。**immediate 让首屏就带上**，否则用户从链接页刷新
 * 回首页时会漏掉。
 *
 * ## 为什么要挡 import.meta.client
 *
 * 这个 watch 之前在服务端也会跑，于是 `addLink` 改了 `useState` —— 但
 * `writeRaw` 里 `if (!import.meta.client) return` 挡住了写 localStorage。
 * 结果是：state 里有了、盘上没有。
 *
 * 那个 state 会被序列化进 __NUXT_DATA__ payload，客户端 hydration 时
 * `useState` 从 payload 恢复成 `[token]`。于是客户端的 addLink 看到
 * 「已经收藏过了」→ 返回 false → 不写盘；紧接着 onMounted 的 hydrateLinks
 * 用空的 localStorage 覆盖 → token 彻底消失。
 *
 * 净效果是 localStorage 永远空、侧栏永远空，而且每次刷新都一样 ——
 * 因为「已收藏」的判断读的是被污染过的 state。这条守卫是那个 bug 的根修复。
 */
watch(
  urlLink,
  (token) => {
    // 收藏是纯客户端动作：localStorage 在 SSR 阶段不存在，
    // 在服务端改 state 只会污染 payload（见上面的说明）
    if (!import.meta.client) return
    if (!token) return
    if (addLink(token)) {
      // 新收藏的：让它立刻出现在侧栏里
      void refreshLinks()
    }
  },
  { immediate: true }
)

watch(isLoggedIn, (ok) => {
  if (ok) {
    loadPeople()
    void refreshLinks()
  } else {
    people.value = []
    selectedUserId.value = null
    // 退登后侧栏不再显示链接段，但当前正在看的链接要留在页面上
    selectedKind.value = selectedToken.value ? 'link' : null
  }
}, { immediate: true })

onMounted(() => {
  /**
   * 顺序：**先 hydrate 再校验**，不能反过来。
   *
   * hydrateLinks 会用 localStorage 覆盖 tokens，所以它必须在所有 addLink
   * 之后跑（URL 上那条由上面的 watch 补进来），否则会把刚收藏的抹掉。
   * 那个 watch 的 immediate 在 setup 阶段就触发了，早于 onMounted，顺序天然对。
   */
  hydrateLinks()
  if (tokens.value.length) void refreshLinks()
})

let timer: ReturnType<typeof setTimeout> | undefined
watch(userSearch, () => {
  clearTimeout(timer)
  timer = setTimeout(loadPeople, 250)
})
onBeforeUnmount(() => clearTimeout(timer))

definePageMeta({ layout: false })
</script>