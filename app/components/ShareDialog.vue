<template>
  <Teleport to="body">
    <Transition name="share-modal">
      <div v-if="open" class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
        <div class="absolute inset-0 bg-gray-900/40" aria-hidden="true" @click="close" />

        <div
          class="ui-glass relative flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="isBulk ? `批量设置分享：${bulkCount} 项` : `分享：${name}`"
        >
          <!-- 头部 -->
          <div class="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
            <div class="min-w-0 flex-1">
              <!--
                批量模式的标题行。与单项同一个 h2，不另开一个 ——
                两条分支的图标、「xxx」宽度规则、truncate 行为完全一样，
                拆开就是两份会分叉的布局。
              -->
              <h2 v-if="isBulk" class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <ShareIcon class="h-4 w-4 shrink-0 text-gray-500" />
                <span class="shrink-0 whitespace-nowrap">批量设置分享</span>
                <span class="min-w-0 truncate font-normal text-gray-500">{{ bulkCount }} 项</span>
              </h2>
              <!--
                标题行。「分享」两个字必须保住：不给它 shrink-0，flex 会把它
                压得比一个字还窄，中文于是可以在字与字之间断行 —— 于是「分享」
                竖着排成两行，而本该折叠的是后面的名字。

                名字那一侧要 min-w-0 才能 truncate：flex 子项的 min-width 默认
                是 auto（内容宽度），不给它放开就永远不会触发省略号。
                所以让「分享」不可压缩、名字可压缩到任意窄，折叠就落在名字上。
              -->
              <h2 v-if="!isBulk" class="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <ShareIcon class="h-4 w-4 shrink-0 text-gray-500" />
                <span class="shrink-0 whitespace-nowrap">分享</span>
                <span class="min-w-0 truncate font-normal text-gray-500" :title="name">{{ name }}</span>
              </h2>
              <p class="mt-0.5 text-xs text-gray-500">
                <!--
                  批量模式不印「文件夹 / 文件」：一个选择里两类可以混着，
                  「文件夹」或「文件」都会有一半是错的。改成列出前几项的名字 ——
                  用户要确认的是「我选中的确实是这几项」，不是它们的类型。
                -->
                <template v-if="isBulk">
                  <span class="block truncate" :title="bulkNamesTitle">{{ bulkNamesPreview }}</span>
                </template>
                <template v-else>
                  <component :is="isFolder ? FolderIcon : DocumentIcon" class="mr-0.5 inline h-3 w-3 align-[-2px]" />
                  {{ isFolder ? '文件夹' : '文件' }}
                </template>
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
            <!--
              批量模式的覆盖警告。

              批量是**整体复写**，而初值是空的（继承 · 不公开 · 空名单）。
              于是「打开弹窗什么都不改直接点应用」= 把 N 项刷成默认态、清掉所有
              现有授权、把原本「分享」的文件夹退回「继承」（等于在子树上撤了一道
              边界，影响整棵子树）。

              这不是 bug，是覆盖语义的必然，但用户不会自己想到 —— 所以要把
              「会被毁掉的东西」摆在动手之前。

              没有破坏就不显示：没有要警告的东西时一条空横幅比没有更糟。
              判据是 bulkWipeNotes（真的会被这次应用毁掉的项）。
            -->
            <div
              v-if="isBulk && bulkWipeNotes.length"
              class="mb-3 flex items-start gap-2 rounded-lg border-l-4 border-amber-400 bg-amber-50 px-3 py-2"
            >
              <ExclamationTriangleIcon class="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div class="text-xs leading-relaxed text-amber-800">
                <p class="font-medium">提交会覆盖下面这些现有设置：</p>
                <ul class="mt-1 list-disc space-y-0.5 pl-4">
                  <li v-for="n in bulkWipeNotes" :key="n">{{ n }}</li>
                </ul>
              </div>
            </div>

            <!--
              批量模式常驻的一条：这次应用的完整结果。用户不该靠点下去才知道
              会变成什么样 —— confirm 是最后一道，不是唯一一道。
            -->
            <p
              v-if="isBulk"
              class="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600"
            >
              提交后，{{ bulkCount }} 项会全部设为：<span class="font-medium text-gray-900">{{ bulkOutcomeText }}</span>
              <span class="mt-0.5 block text-gray-400">这是覆盖，不是合并。</span>
            </p>

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
            <!--
              分享链接区。批量模式整块隐藏：N 项就是 N 条链接，弹窗里会出现 N 个
              分不出彼此的地址块，而且「生成链接」在这条路径下没有对应的服务端
              动作（bulk 的 removeLinks 只管撤销）。撤销链接另有入口 ——
              /shares 页底部的批量条。
            -->
            <div v-if="!isBulk" class="mt-5 border-t border-gray-100 pt-4">
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

            <!--
              批量模式的底部操作条。

              单项模式**没有**这一条：改一下立刻提交，弹窗只是个设置面板。
              批量不能那样 —— 点三态就发一次请求 = N 项 × 3 次，中途失败还会留
              半套（而且用户根本没意识到自己已经改了一部分）。所以攒起来一次提交。

              结果复述印在按钮上方而不是按钮里：按钮放不下这么长一句，
              而藏在按钮 title 里等于没有。
            -->
            <div
              v-if="isBulk"
              class="sticky bottom-0 -mx-4 mt-4 border-t border-gray-100 bg-white/95 px-4 py-3 backdrop-blur"
            >
              <p class="mb-2 truncate text-[11px] text-gray-500" :title="bulkOutcomeText">
                将把 {{ bulkCount }} 项设为：{{ bulkOutcomeText }}
              </p>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                  :disabled="applyingBulk"
                  @click="applyToTargets"
                >
                  {{ applyingBulk ? '正在应用…' : `应用到 ${bulkCount} 项` }}
                </button>
                <button
                  type="button"
                  class="rounded-md px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50"
                  :disabled="applyingBulk"
                  @click="close"
                >
                  取消
                </button>
              </div>
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
import type { ShareBulkTarget, ShareCandidate, ShareGrant, ShareLink, ShareTargetType } from '~/services/share.service'
import { notify, notifyError } from '~/utils/notify'
import {
  formatPermission,
  linkActiveFromShareMode,
  normalizePermission,
  normalizeShareMode,
  PERM_DELETE,
  PERM_DOWNLOAD,
  PERM_READ,
  PERM_WRITE,
  SHARE_INHERIT,
  SHARE_MODE_LABELS,
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

  /**
   * 批量模式：非空时本弹窗一次作用于这些条目，而不是 targetId 那一个。
   *
   * ## 为什么复用本组件而不是新写一个
   *
   * 三态 / 公开 / 名单 / 权限位复选框 / 候选人搜索，这五块**完全一样**，
   * 抄一份就是几百行重复，而两份表单迟早分叉（加一个权限位只改一处就够，
   * 改两处就有一处漏）。
   *
   * ## 与单项目标的三处行为差异（都在本组件内部分流）
   *
   *   1. 不发请求 —— 没有「某一项的现状」可读（多个项的现状各不相同，
   *      而名单本身在列表接口里根本没有，只有 grantCount 个人数）。
   *      初值一律「继承 · 不公开 · 名单为空」，也就是用户选定的语义：
   *      批量是**写入目标**，不是浏览。
   *   2. 改一下**不立刻提交** —— 单项模式点一下就该看到服务端确认的权威值，
   *      批量模式下点三态就发一次请求 = N 项 × 3 次请求，且中途失败会留半套。
   *      所以攒起来由底部「应用到 N 项」一次提交。
   *   3. 链接区整块隐藏 —— N 项就是 N 条链接，弹窗里就是 N 个分不出彼此的
   *      地址块。撤销链接另有入口（/shares 页的批量条 removeLinks）。
   *
   * 每项带上 Shared / IsPublic / grantCount 是为了顶部那条「会被覆盖成什么」
   * 的横幅：数据现成（/api/files 已经返回），零额外请求。
   */
  bulkTargets?: ShareBulkTarget[] | null
}>()

const emit = defineEmits<{ close: []; changed: [] }>()

/** 批量模式。length 判断而不是 null 判断：空数组传进来也不该当批量 */
const isBulk = computed(() => (props.bulkTargets?.length ?? 0) > 0)
const bulkCount = computed(() => props.bulkTargets?.length ?? 0)

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
/**
 * 去抖 + 请求序号一体，见 app/composables/useDebounced.ts。
 */
const {
  schedule: scheduleCandidateSearch,
  cancel: cancelCandidateSearch,
  latest: latestCandidateSearch
} = useDebounced<string>({
  delay: 250,
  run: (q, id) => runCandidateSearch(q, id)
})

watch(
  () => [props.open, props.targetId, props.targetType, isBulk.value] as const,
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
  // 批量模式不读任何一项的现状（见 bulkTargets 的注释）。
  // 初值 = 默认三态 + 不公开 + 空名单，也就是「还没设过」的那一套。
  if (isBulk.value) {
    mode.value = SHARE_INHERIT
    isPublic.value = false
    grants.value = []
    links.value = []
    candidates.value = []
    keyword.value = ''
    searched.value = false
    loading.value = false
    return
  }

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

/**
 * 三态。批量模式下只改本地，不发请求 ——
 * 见 bulkTargets 的注释第 2 点。
 */
async function applyMode(value: number) {
  if (value === mode.value) return
  if (isBulk.value) {
    mode.value = value
    // 不分享态下 IsPublic 无意义（服务端 setShareMode 会顺手清掉它）。
    // 这里跟着一起收，否则界面上会显示「不分享 + 公开」这种自相矛盾的状态，
    // 而提交时服务端会把公开静默丢掉，用户以为设上了。
    if (value === SHARE_NONE) isPublic.value = false
    return
  }
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

/** 公开。批量模式下只改本地，理由同 applyMode */
async function applyPublic(next: boolean) {
  if (isBulk.value) {
    isPublic.value = next
    return
  }
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
 *
 * 批量模式下只改本地（不发请求、失败也不回滚）—— 最终由 applyToTargets 一次提交。
 */
async function submitGrants(next: ShareGrant[], okMessage: string) {
  if (isBulk.value) {
    grants.value = next
    return true
  }
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
  cancelCandidateSearch()
  const q = keyword.value.trim()
  if (!q) {
    candidates.value = []
    searched.value = false
    return
  }
  searching.value = true
  scheduleCandidateSearch(q)
}

/**
 * 候选搜索。**这里原先漏了 SearchDialog 已有的序号守卫** —— 只有 setTimeout +
 * clearTimeout，于是慢的旧请求会覆盖新结果：搜「张」慢、搜「张三」快，
 * 「张」的结果后到把候选列表刷成旧的。
 *
 * SearchDialog 早修好了这个 bug（它的 runSearch 里有 `if (id !== latest()) return`），
 * ShareDialog 上没跟上 —— 两个组件把同一套逻辑各抄一遍、只修了一处的典型后果。
 * 现在两边共用 useDebounced，守卫不可能再被忘掉。
 */
async function runCandidateSearch(q: string, id: number) {
  try {
    // 属主本人不能进授权名单（服务端 assertGrantees 会 400）。
    // 管理视角下属主是 targetUserId，不是「我」，所以要单独塞进去。
    const exclude = grants.value.map((g) => g.userId)
    if (props.useAdmin && props.targetUserId != null) exclude.push(props.targetUserId)
    const res = await ShareService.candidates(q, exclude)
    // 过期的那次直接丢弃：它的关键词已经不是输入框里那个了
    if (id !== latestCandidateSearch()) return
    candidates.value = res.candidates ?? []
  } catch {
    if (id !== latestCandidateSearch()) return
    candidates.value = []
  } finally {
    if (id === latestCandidateSearch()) {
      searching.value = false
      searched.value = true
    }
  }
}

/* ---------------- 批量模式：覆盖警告 + 一次提交 ---------------- */

/**
 * 所选项**当前**的状态汇总，用来在顶部横幅里说明「会被覆盖成什么」。
 *
 * 数据来自 /api/files 已经返回的字段，零额外请求。判三态一律走
 * normalizeShareMode —— 它对 boolean / 脏值有显式守卫，自己写 `=== 1` 的话
 * `Number(true) === 1 === SHARE_SHARED` 会把「继承」算成「分享」。
 */
const bulkCurrentSummary = computed(() => {
  const targets = props.bulkTargets ?? []
  let withGrants = 0
  let grantPeople = 0
  let isPublicCount = 0
  let notInherit = 0
  for (const t of targets) {
    const n = Number(t.grantCount ?? 0)
    if (n > 0) {
      withGrants++
      grantPeople += n
    }
    if (t.IsPublic === true) isPublicCount++
    if (normalizeShareMode(t.Shared) !== SHARE_INHERIT) notInherit++
  }
  return { withGrants, grantPeople, isPublicCount, notInherit, total: targets.length }
})

/**
 * 「会被清掉的东西」清单。为空就不显示横幅 —— 没有破坏就没有警告，
 * 满屏警告等于没有警告。
 *
 * 只列**确实会被这次应用毁掉**的项：
 *   名单非空 → 提交时 grants 一定是数组（初值空数组），非空即整体复写
 *   已公开   → 复写 isPublic = false
 *   非继承三态 → 会被压成弹窗里当前选的那个（默认「继承」）
 * 这三件都不是「用户改了三态」必然会想到的后果，尤其第一件。
 */
const bulkWipeNotes = computed<string[]>(() => {
  const s = bulkCurrentSummary.value
  const notes: string[] = []
  if (s.withGrants > 0) {
    notes.push(`${s.withGrants} 项当前有授权名单（共 ${s.grantPeople} 人），提交后会被清空`)
  }
  if (s.isPublicCount > 0) {
    notes.push(`${s.isPublicCount} 项当前是公开的，提交后会变成不对外公开`)
  }
  if (s.notInherit > 0) {
    notes.push(`${s.notInherit} 项当前不是「继承」态，提交后会被压成「${SHARE_MODE_LABELS[mode.value]}」`)
  }
  return notes
})

/** 应用按钮上那一句结果复述。用户点之前就该知道会变成什么样 */
const bulkOutcomeText = computed(
  () =>
    `${mode.value === SHARE_NONE ? '不公开' : isPublic.value ? '公开' : '不对外公开'} · ` +
    `${SHARE_MODE_LABELS[mode.value]} · ` +
    (grants.value.length ? `授权 ${grants.value.length} 人` : '清空授权名单')
)

const applyingBulk = ref(false)

/**
 * 一次提交给所有项。
 *
 * ## 为什么必须过 confirm
 *
 * 批量是**整体复写**，而初值是空的（继承 · 不公开 · 空名单）。
 * 于是「打开弹窗直接点应用」= 把 N 项刷成默认态、清掉所有现有授权、
 * 把原本是「分享」的文件夹退回「继承」（那等于在子树上撤了一道边界，
 * 影响整棵子树）。这不是 bug，是覆盖语义的必然，但用户不会自己想到。
 *
 * ## 为什么失败要逐项说出来
 *
 * 服务端逐项校验属主：混进来的别人的 id 会单独 ok:false，其余照常执行。
 * 只回一个「成功」的话，用户会以为全做完了 —— 直到下次刷新才发现有几项没变。
 */
/**
 * 批量模式下标题那行印什么。
 *
 * 印前 3 项 + 「等 N 项」：印全是几十行，印一项看不出是批量。
 * title 属性放全量，悬停能看全 —— 与上面名字那一列的处理一致。
 */
const BULK_PREVIEW_NAMES = 3
const bulkNamesPreview = computed(() => {
  const names = (props.bulkTargets ?? []).map((t) => t.name)
  const shown = names.slice(0, BULK_PREVIEW_NAMES).join('、')
  return names.length > BULK_PREVIEW_NAMES
    ? `${shown} 等 ${names.length} 项`
    : shown
})
const bulkNamesTitle = computed(() => (props.bulkTargets ?? []).map((t) => t.name).join('\n'))

async function applyToTargets() {
  if (!isBulk.value || applyingBulk.value) return

  if (!window.confirm(
    `把 ${bulkCount.value} 项全部设为下面这样？\n\n` +
    `· 共享方式：${SHARE_MODE_LABELS[mode.value]}\n` +
    `· 公开：${mode.value === SHARE_NONE ? '不公开' : isPublic.value ? '公开（所有登录用户可读）' : '否'}\n` +
    `· 授权名单：${grants.value.length ? `${grants.value.length} 人（会替换掉现有全部授权）` : '清空'}\n\n` +
    (bulkWipeNotes.value.length
      ? `注意：\n· ${bulkWipeNotes.value.join('\n· ')}\n\n`
      : '') +
    '这是覆盖，不是合并。'
  )) return

  applyingBulk.value = true
  try {
    const res = await ShareService.bulkApply(
      (props.bulkTargets ?? []).map((t) => ({ targetType: t.targetType, targetId: t.targetId })),
      {
        mode: mode.value,
        isPublic: mode.value === SHARE_NONE ? false : isPublic.value,
        grants: grants.value.map((g) => ({ userId: g.userId, permission: g.permission }))
      },
      { useAdmin: props.useAdmin, targetUserId: props.targetUserId }
    )

    if (res.failCount === 0) {
      notify(`已应用到 ${res.okCount} 项`, 'success')
    } else {
      // 逐项原因去重后列出：20 项全被同一句「只有属主可以管理分享」拦掉时，
      // 印 20 遍没有信息量
      const reasons = Array.from(
        new Set(res.results.filter((r) => !r.ok).map((r) => r.message ?? '操作失败'))
      )
      notify(
        `成功 ${res.okCount} 项，失败 ${res.failCount} 项：${reasons.join('；')}`,
        'error'
      )
    }
    // 成功与部分失败都要刷新：成功的那几项界面上的角标已经过期了
    emit('changed')
    close()
  } catch (e) {
    notifyError(e, '批量设置分享失败')
  } finally {
    applyingBulk.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) close()
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    // 定时器与在飞请求由 useDebounced 自己在 onBeforeUnmount 里取消
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
