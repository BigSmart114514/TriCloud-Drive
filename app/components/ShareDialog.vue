<template>
  <Teleport to="body">
    <Transition name="share-modal">
      <div v-if="open" class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
        <div class="absolute inset-0 bg-gray-900/40" aria-hidden="true" @click="close" />

        <div
          class="ui-glass relative flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="`分享：${name}`"
        >
          <!-- 头部 -->
          <div class="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <ShareIcon class="h-4 w-4 shrink-0 text-gray-500" />
                分享
                <span class="truncate font-normal text-gray-500">{{ name }}</span>
              </h2>
              <p class="mt-0.5 text-xs text-gray-500">
                <component :is="isFolder ? FolderIcon : DocumentIcon" class="mr-0.5 inline h-3 w-3 align-[-2px]" />
                {{ isFolder ? '文件夹' : '文件' }}
                <span v-if="ownerLabel"> · 属主 {{ ownerLabel }}</span>
              </p>
            </div>
            <button
              type="button"
              class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              aria-label="关闭"
              @click="close"
            >
              <XMarkIcon class="h-5 w-5" />
            </button>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            <!-- 管理员模式：这是替别人改，标题栏那行「属主 xxx」容易被忽略 -->
            <div
              v-if="useAdmin"
              class="mb-3 flex items-start gap-2 rounded-lg border-l-4 border-amber-400 bg-amber-50 px-3 py-2"
            >
              <ShieldExclamationIcon class="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p class="text-xs leading-relaxed text-amber-800">
                管理员模式：你正在修改<template v-if="ownerLabel"><span class="font-medium">{{ ownerLabel }}</span> 的</template>分享设置。
              </p>
            </div>

            <!-- 分享方式：三态 -->
            <fieldset>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="m in MODE_OPTIONS"
                  :key="m.value"
                  type="button"
                  class="rounded-lg border px-2 py-2.5 text-center text-sm font-medium transition-colors"
                  :class="mode === m.value
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300 hover:bg-gray-50'"
                  :aria-pressed="mode === m.value"
                  :disabled="busy"
                  @click="applyMode(m.value)"
                >
                  {{ m.label }}
                </button>
              </div>
            </fieldset>

            <!-- 公开 -->
            <div class="mt-4 flex items-start gap-3 rounded-lg border border-gray-200 p-3">
              <GlobeAltIcon class="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
              <div class="min-w-0 flex-1">
                <label class="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-900">
                  <input
                    type="checkbox"
                    class="h-4 w-4 rounded border-gray-300 text-indigo-600"
                    :checked="isPublic"
                    :disabled="busy || mode === SHARE_NONE"
                    @change="applyPublic(($event.target as HTMLInputElement).checked)"
                  />
                  公开（所有登录用户可读）
                </label>
                <p v-if="mode === SHARE_NONE" class="mt-1 text-[11px] leading-relaxed text-amber-600">
                  当前为「不分享」，公开不可用。
                </p>
              </div>
            </div>

            <!-- 授权人员 -->
            <div class="mt-5">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-xs font-medium text-gray-500">
                  已授权人员
                  <span v-if="grants.length" class="text-gray-400">({{ grants.length }})</span>
                </h3>
                <span v-if="mode === SHARE_NONE" class="text-[11px] text-amber-600">不分享状态下名单不生效</span>
              </div>

              <p v-if="loading" class="py-4 text-center text-xs text-gray-400">加载中…</p>
              <p v-else-if="!grants.length" class="rounded-lg bg-gray-50 py-4 text-center text-xs text-gray-400">
                还没有授权给任何人
              </p>

              <ul v-else class="space-y-1.5">
                <li
                  v-for="g in grants"
                  :key="g.userId"
                  class="rounded-lg border border-gray-100 px-2.5 py-2"
                >
                  <!-- 上行：头像 + 名字 + 移除 -->
                  <div class="flex items-center gap-2.5">
                    <span
                      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-400 to-slate-500 text-xs font-semibold text-white"
                    >
                      {{ (g.user?.username || g.user?.email || 'U').slice(0, 1).toUpperCase() }}
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm text-gray-900">{{ g.user?.username || '未知用户' }}</span>
                      <span class="block truncate text-[11px] text-gray-500">{{ g.user?.email || '—' }}</span>
                    </span>
                    <button
                      type="button"
                      class="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                      :disabled="busy"
                      :aria-label="`移除 ${g.user?.username}`"
                      title="移除"
                      @click="removeGrant(g.userId)"
                    >
                      <XMarkIcon class="h-4 w-4" />
                    </button>
                  </div>
                  <!--
                    下行：四个权限位独立勾选。原来是一个三档 <select>，
                    加了 download 之后 16 种组合下拉表达不了（read ⊂ write ⊂ delete
                    那条单轴也已被打破），所以改成按位复选。
                  -->
                  <div
                    class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-10"
                    role="group"
                    :aria-label="`${g.user?.username} 的权限`"
                  >
                    <label
                      v-for="p in PERM_BIT_OPTIONS"
                      :key="p.value"
                      class="inline-flex cursor-pointer items-center gap-1 text-[11px] text-gray-600 select-none"
                      :class="busy ? 'opacity-50' : ''"
                      :title="p.hint"
                    >
                      <input
                        type="checkbox"
                        class="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600"
                        :checked="(g.permission & p.value) !== 0"
                        :disabled="busy"
                        @change="togglePermission(g.userId, p.value, ($event.target as HTMLInputElement).checked)"
                      />
                      {{ p.label }}
                    </label>
                    <span class="ml-auto text-[11px] text-gray-400">{{ formatPermission(g.permission) }}</span>
                  </div>
                </li>
              </ul>
            </div>

            <!--
              分享链接。与授权名单是两套独立的机制：
              名单是「授权给具体的人」，链接是「任何拿到 token 的人都能看」。
              一个节点可以同时挂多条链接 —— 发A 给甲、发 B 给乙，泄露时能精确撤A。

              链接权限锁死「读 + 下载」，不给写/删（匿名 bearer token 没有身份
              可追责）。要改权限只能改三态/名单，链接本身没有可配项。
            -->
            <div class="mt-5 border-t border-gray-100 pt-4">
              <div class="mb-2 flex items-center justify-between gap-2">
                <h3 class="text-xs font-medium text-gray-500">
                  分享链接
                  <span v-if="links.length" class="text-gray-400">({{ links.length }})</span>
                </h3>
                <button
                  type="button"
                  class="flex shrink-0 items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                  :disabled="busy"
                  @click="addLink"
                >
                  <PlusIcon class="h-3.5 w-3.5" />
                  生成链接
                </button>
              </div>

              <!--
                继承态下的链接是「预设」：它要等自己或某个祖先被拍板成「分享」
                才生效，服务端对此会返回 404。属主在这里看不到后果，所以要提示。
                判据是「目标自身是不是分享态」，与服务端 BOUNDARY_CTE 同一套推导。
              -->
              <p
                v-if="willLinkBeDead"
                class="mb-2 flex items-start gap-1.5 rounded-lg border-l-4 border-amber-400 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800"
              >
                <ExclamationTriangleIcon class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {{ LINK_DEAD_HINT }}
              </p>

              <p v-if="loading" class="py-3 text-center text-xs text-gray-400">加载中…</p>
              <p
                v-else-if="!links.length"
                class="rounded-lg bg-gray-50 py-3 text-center text-xs text-gray-400"
              >
                还没有分享链接。生成后任何拿到地址的人都能查看与下载
              </p>

              <ul v-else class="space-y-1.5">
                <li
                  v-for="l in links"
                  :key="l.id"
                  class="rounded-lg border border-gray-100 px-2.5 py-2"
                >
                  <div class="flex items-center gap-2">
                    <code class="min-w-0 flex-1 truncate rounded bg-gray-50 px-1.5 py-1 font-mono text-[11px] text-gray-700" :title="l.url">
                      {{ l.url }}
                    </code>
                    <button
                      type="button"
                      class="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                      :disabled="busy"
                      :aria-label="`复制 ${l.url}`"
                      title="复制链接"
                      @click="copyLink(l.url)"
                    >
                      <ClipboardDocumentIcon class="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      class="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      :disabled="busy"
                      :aria-label="`撤销 ${l.url}`"
                      title="撤销此链接"
                      @click="removeLink(l)"
                    >
                      <XMarkIcon class="h-4 w-4" />
                    </button>
                  </div>
                  <p class="mt-1 pl-1 text-[11px] text-gray-400">
                    查看和下载 · 生成于 {{ l.createdAt || '—' }}
                  </p>
                </li>
              </ul>
            </div>

            <!-- 添加人员 -->
            <div class="mt-5 border-t border-gray-100 pt-4">
              <h3 class="mb-2 text-xs font-medium text-gray-500">添加人员</h3>
              <div class="relative">
                <MagnifyingGlassIcon class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  v-model="keyword"
                  type="search"
                  placeholder="输入用户名或邮箱搜索"
                  aria-label="搜索用户"
                  class="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-sm placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  @input="searchCandidates"
                />
              </div>

              <ul v-if="candidates.length" class="mt-2 max-h-52 space-y-1 overflow-y-auto">
                <li
                  v-for="c in candidates"
                  :key="c.id"
                  class="flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-gray-50"
                >
                  <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] font-semibold text-gray-600">
                    {{ (c.username || c.email || 'U').slice(0, 1).toUpperCase() }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-gray-900">{{ c.username }}</span>
                    <span class="block truncate text-[11px] text-gray-500">{{ c.email || '—' }}</span>
                  </span>
                  <button
                    type="button"
                    class="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                    :disabled="busy"
                    @click="addGrant(c)"
                  >
                    添加
                  </button>
                </li>
              </ul>
              <p v-else-if="searched && !searching" class="mt-2 text-center text-xs text-gray-400">
                没有匹配的用户
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  ClipboardDocumentIcon,
  DocumentIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ShareIcon,
  ShieldExclamationIcon,
  XMarkIcon
} from '@heroicons/vue/24/outline'
import { ShareService } from '~/services/share.service'
import type { ShareCandidate, ShareGrant, ShareLink, ShareTargetType } from '~/services/share.service'
import { notify, notifyError } from '~/utils/notify'
import {
  formatPermission,
  linkActiveFromShareMode,
  normalizePermission,
  PERM_DELETE,
  PERM_DOWNLOAD,
  PERM_READ,
  PERM_WRITE,
  SHARE_INHERIT,
  SHARE_NONE,
  SHARE_SHARED
} from '~~/types/share'

/**
 * 继承态下生成的链接是「预设」，要等自己或祖先被拍板成「分享」才生效。
 *
 * 与 types/share.ts 的 LINK_DOT_TITLE 是同一份语义（同一件事，两处文案面向的
 * 场景不同：这里是弹窗里的黄条，那里是图标上的悬浮提示）。
 *
 * 原来那句末尾还夹了「图标上会出现红点提示这件事」—— 那是在让用户去看另一个
 * UI 元素，纯噪音，删掉了。同理「这个节点」改成「文件夹」：看到这条提示的人
 * 一定是在文件夹的分享弹窗里，而「节点」是内部术语。
 */
const LINK_DEAD_HINT =
  '这个链接现在打不开。文件夹还是「继承」状态，设为「分享」之后才生效。'

const props = defineProps<{
  open: boolean
  targetType: 'file' | 'folder'
  targetId: number | null
  name?: string
  ownerLabel?: string
  /** /manage/files 里管理员在替别人改分享。透传给服务端换 authUserId */
  useAdmin?: boolean
  /** 管理视角下被浏览的用户（分享设置的真正属主） */
  targetUserId?: number | null
}>()

const emit = defineEmits<{ close: []; changed: [] }>()

const isFolder = computed(() => props.targetType === 'folder')

/** 分享目标的完整作用域：管理视角要把 useAdmin / targetUserId 一起发过去 */
const scope = computed<ShareTargetType>(() => ({
  targetType: props.targetType,
  targetId: props.targetId!,
  useAdmin: props.useAdmin,
  targetUserId: props.targetUserId
}))

const MODE_OPTIONS = [
  { value: SHARE_NONE, label: '不分享' },
  { value: SHARE_SHARED, label: '分享' },
  { value: SHARE_INHERIT, label: '继承' }
]

/**
 * 权限位复选框。四个位**相互独立**，所以是复选框而不是三档下拉 ——
 * 「能看能改但不许下载」这类组合下拉表达不了。
 *
 * 下载那一项的 hint 要点明预览也走它：预览调的是 /api/files/download，
 * 一样扣下载流量，所以两者由同一个位管。
 */
const PERM_BIT_OPTIONS = [
  { value: PERM_READ, label: '查看', hint: '列目录、看文件信息' },
  { value: PERM_WRITE, label: '编辑', hint: '上传、重命名、移动' },
  { value: PERM_DELETE, label: '删除', hint: '删除文件或文件夹' },
  { value: PERM_DOWNLOAD, label: '下载', hint: '下载文件；预览也走这里，一样消耗下载流量' }
]

const mode = ref<number>(SHARE_INHERIT)
const isPublic = ref(false)
const grants = ref<ShareGrant[]>([])
const links = ref<ShareLink[]>([])
const loading = ref(false)
const busy = ref(false)

/**
 * 现在生成链接会不会是死的。
 *
 * 判据是「目标自身是不是分享态」—— 与服务端的 BOUNDARY_CTE 同一套推导
 * （见 types/share.ts 的 linkActiveFromShareMode），不查库、不多发请求。
 * 「不分享」态也一样是死的（自己就是墙），那种节点已经有锁角标了，
 * 但链接打不开这件事仍然要说。
 */
const willLinkBeDead = computed(() => !linkActiveFromShareMode(mode.value))

const keyword = ref('')
const candidates = ref<ShareCandidate[]>([])
const searching = ref(false)
const searched = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => [props.open, props.targetId, props.targetType] as const,
  ([open]) => {
    if (open) load()
    else reset()
  }
)

function reset() {
  grants.value = []
  links.value = []
  candidates.value = []
  keyword.value = ''
  searched.value = false
  loading.value = false
  busy.value = false
}

async function load() {
  if (!props.targetId) return
  loading.value = true
  try {
    const res = await ShareService.list(scope.value)
    mode.value = res.mode
    isPublic.value = res.IsPublic
    grants.value = res.grants ?? []
    // 服务端 list / mode / add 三个接口都带 links（withShareLinkUrls），
    // 少一个就会在「改完别的东西」之后把链接列表抹空
    links.value = res.links ?? []
  } catch (e: any) {
    // 分享状态只有属主能看能改。被授权人打开时直接关窗：
    // 留一个空壳 + 一条报错弹窗比不给入口更糟
    if (e?.statusCode === 403 || e?.status === 403) {
      close()
      return
    }
    notifyError(e, '加载分享信息失败')
  } finally {
    loading.value = false
  }
}

function close() {
  emit('close')
}

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<T | null> {
  if (busy.value) return null
  busy.value = true
  try {
    return await fn()
  } catch (e) {
    notifyError(e, fallback)
    return null
  } finally {
    busy.value = false
  }
}

async function applyMode(value: number) {
  if (value === mode.value) return
  const prev = mode.value
  mode.value = value
  const res = await run(
    () => ShareService.setState(scope.value, { mode: value as any }),
    '设置分享方式失败'
  )
  if (res) {
    isPublic.value = res.IsPublic
    // 改三态不删链接，但链接**会不会生效**变了（红点那条判据）。
    // 服务端把 links 一起带回来是为了返回结构一致，这里不需要用它覆盖 ——
    // 覆盖也没坏处，但没必要为了一次无变化的赋值去信任返回值。
    notify(res.statusMessage, 'success')
    emit('changed')
  } else {
    mode.value = prev
  }
}

async function applyPublic(next: boolean) {
  const prev = isPublic.value
  isPublic.value = next
  const res = await run(
    () => ShareService.setState(scope.value, { isPublic: next }),
    '设置公开失败'
  )
  if (res) {
    isPublic.value = res.IsPublic
    mode.value = res.mode
    notify(res.statusMessage, 'success')
    emit('changed')
  } else {
    isPublic.value = prev
  }
}

/**
 * 提交整份名单。名单是覆盖语义：传什么就是最终结果。
 * 所以「改某人权限」「加人」「移人」都只是先在本地算出新的名单再重发，
 * 服务端自己算出增删改（server/utils/share.ts 的 replaceAccess）。
 */
async function submitGrants(next: ShareGrant[], okMessage: string) {
  const snapshot = grants.value
  grants.value = next
  const res = await run(
    () => ShareService.setState(
      scope.value,
      { grants: next.map((g) => ({ userId: g.userId, permission: g.permission })) }
    ),
    '保存授权名单失败'
  )
  if (res) {
    // 服务端回传的是权威值（标签、用户名可能已变），用它覆盖本地
    if (Array.isArray(res.grants)) grants.value = res.grants
    // 同理覆盖 links：少了这一步，「改完名单」之后链接列表会被抹空
    if (Array.isArray(res.links)) links.value = res.links
    notify(res.statusMessage || okMessage, 'success')
    emit('changed')
    return true
  }
  grants.value = snapshot
  return false
}

/**
 * 勾/取消某一个权限位。
 *
 * 每次只改一位、立刻提交（而不是「攒一串改动再一起存」），和原来的下拉
 * 行为一致 —— 用户点一下就该看到服务端确认的权威值。
 *
 * 「全权但不许下载」这个组合**表达不了**：15 去掉 download 位正好是 7，
 * 而 7 是存量数据的「全权」编码，normalizePermission 会把它补回 15
 * （见 types/share.ts 的 LEGACY_FULL_MASK）。所以从全权状态单独取消
 * 「下载」会被拒绝，提示用户先去掉查看/编辑/删除中的任意一项 ——
 * 那才是「不给下载」的真实意图。
 *
 * 提交前过一遍 normalizePermission：剔除未定义的位，避免脏掩码落库。
 */
async function togglePermission(userId: number, bit: number, on: boolean) {
  const target = grants.value.find((g) => g.userId === userId)
  if (!target) return

  if (!on && bit === PERM_DOWNLOAD) {
    const others = PERM_READ | PERM_WRITE | PERM_DELETE
    if ((target.permission & others) === others) {
      notify('「全权但不许下载」这个组合无法表示（它与「读写删」的编码相同）。请先取消查看、编辑或删除中的一项。', 'error')
      return
    }
  }

  const raw = on ? target.permission | bit : target.permission & ~bit
  const permission = normalizePermission(raw)
  const next = grants.value.map((g) => (g.userId === userId ? { ...g, permission } : g))
  await submitGrants(next, '权限已更新')
}

async function addGrant(c: ShareCandidate) {
  // 默认给「查看 + 编辑 + 下载」，不含删除。加进来就能正常用（能看能预览能改），
  // 但删不了 —— 删除是不可逆的，留给属主显式勾。要下载是因为预览走下载接口，
  // 不给的话对方连预览都做不到，等于只给了个目录浏览。
  const permission = PERM_READ | PERM_WRITE | PERM_DOWNLOAD
  const next = [...grants.value, { userId: c.id, permission, user: { username: c.username, email: c.email } }]
  if (await submitGrants(next, `已授权给 ${c.username}`)) {
    candidates.value = candidates.value.filter((x) => x.id !== c.id)
  }
}

/**
 * 生成一条链接。
 *
 * 用 add 而不是复用 setState：链接是独立的一张表，与三态/名单无关。
 * 服务端返回完整列表，直接覆盖本地 —— 省掉一次 refetch，
 * 也避免「add 成功但列表没更新」这种半成功状态。
 */
async function addLink() {
  const res = await run(
    () => ShareService.addLink(scope.value),
    '生成分享链接失败'
  )
  if (res) {
    links.value = res.links ?? links.value
    notify(res.statusMessage, 'success')
    emit('changed')
  }
}

/** 按 token 撤销。幂等：撤销不存在的也返回成功，不用先查 */
async function removeLink(l: ShareLink) {
  if (!confirm(`撤销这个分享链接？\n\n${l.url}\n\n撤销后任何拿到它的人都打不开了。已经下载走的内容无法收回。`)) return
  const res = await run(
    () => ShareService.removeLink(l.link, scope.value),
    '撤销分享链接失败'
  )
  if (res) {
    // 本地也删一条，免得在服务端成功之后界面还显示着（要等下次 load 才刷新）
    links.value = links.value.filter((x) => x.link !== l.link)
    notify(res.statusMessage, 'success')
    emit('changed')
  }
}

/**
 * 复制地址。
 *
 * 用 execCommand 而不是 navigator.clipboard.writeText：后者只在
 * 安全上下文（HTTPS 或 localhost）可用，而这个应用很可能跑在
 * 裸 IP + HTTP 上 —— 那条路会直接 reject。
 */
async function copyLink(url: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url)
    } else {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (!ok) throw new Error('execCommand 复制失败')
    }
    notify('链接已复制', 'success')
  } catch {
    notify('复制失败，请手动选中链接文本复制', 'error')
  }
}

async function removeGrant(userId: number) {
  const next = grants.value.filter((g) => g.userId !== userId)
  await submitGrants(next, '已移除授权')
}

function searchCandidates() {
  clearTimeout(searchTimer)
  const q = keyword.value.trim()
  if (!q) {
    candidates.value = []
    searched.value = false
    return
  }
  searching.value = true
  searchTimer = setTimeout(async () => {
    try {
      // 属主本人不能进授权名单（服务端 assertGrantees 会 400）。
      // 管理视角下属主是 targetUserId，不是「我」，所以要单独塞进去。
      const exclude = grants.value.map((g) => g.userId)
      if (props.useAdmin && props.targetUserId != null) exclude.push(props.targetUserId)
      const res = await ShareService.candidates(q, exclude)
      candidates.value = res.candidates ?? []
    } catch {
      candidates.value = []
    } finally {
      searching.value = false
      searched.value = true
    }
  }, 250)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) close()
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    clearTimeout(searchTimer)
  })
}
</script>

<style scoped>
.share-modal-enter-active,
.share-modal-leave-active {
  transition: opacity 0.18s ease;
}
.share-modal-enter-active > div:last-child,
.share-modal-leave-active > div:last-child {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.share-modal-enter-from,
.share-modal-leave-to {
  opacity: 0;
}
.share-modal-enter-from > div:last-child,
.share-modal-leave-to > div:last-child {
  transform: translateY(16px);
}
@media (min-width: 640px) {
  .share-modal-enter-from > div:last-child,
  .share-modal-leave-to > div:last-child {
    transform: scale(0.97);
  }
}
</style>
