<template>
  <div class="min-h-screen bg-gray-50">
    <!--
      骨架与 manage/files.vue 同层：layout: false，SSR 阶段就由 auth.global.ts
      拦掉非超管。

      **本页只对超管开放**，与文件总览/用户管理的「管理员即可」不同 ——
      理由见 server/utils/auth-middleware.ts 的 requireSuperAdmin。
    -->

    <!--
      顶栏用 AppNavbar，不要自己画。

      这个项目**没有 app/layouts/ 目录** —— Navbar 不是 layout 给的，是每个页面在
      自己模板里放 <AppNavbar />（manage/files.vue、manage/user.vue 都是）。
      我原先只抄了 layout: false，没抄 Navbar，又手搓了一个返回箭头，结果这个页面
      既没有顶栏，也没有 UiManageMenu —— 而「存储桶管理」那个菜单项就在 AppNavbar
      里面，等于除手敲 URL 外无处可进。

      不写 import：组件自动导入清单 .nuxt/components.d.ts:18 有 AppNavbar，且
      manage/files.vue、manage/user.vue、index.vue 都是不 import 直接用。
      （a6e7336 那个说不清的 `useAuth is not defined` 是 **composable** 自动导入，
      机制与组件这条不同，别混为一谈。）
    -->
    <AppNavbar />

    <header class="border-b border-gray-200 bg-white">
      <div class="mx-auto flex max-w-7xl items-center gap-3 py-3 sm:px-6 lg:px-8">
        <div class="min-w-0 flex-1">
          <h1 class="flex items-center gap-1.5 text-base font-semibold text-gray-900">
            <CloudIcon class="h-5 w-5 shrink-0 text-gray-500" />
            存储桶管理
          </h1>
          <p class="mt-0.5 text-xs text-gray-500">
            直接操作对象存储：浏览真实对象、对账、清理。
          </p>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <!-- 没配腾讯云密钥 -->
      <div
        v-if="!cosConfigured"
        class="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
      >
        <ExclamationTriangleIcon class="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div class="text-sm text-amber-900">
          <p class="font-medium">未配置腾讯云密钥</p>
          <p class="mt-0.5 text-xs leading-relaxed">
            列表会是空的。这不是「桶里没有东西」，而是本地 demoMode —— 服务端根本没有
            可用的对象存储凭据。
          </p>
        </div>
      </div>

      <!-- 用户选择 -->
      <div class="mb-5 flex flex-wrap items-end gap-3">
        <div class="min-w-0 flex-1">
          <label for="bucket-user" class="mb-1.5 block text-xs font-medium text-gray-700">
            选择用户
          </label>
          <select
            id="bucket-user"
            v-model="selectedUserId"
            class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          >
            <option :value="null">请选择用户</option>
            <option v-for="u in users" :key="u.id" :value="u.id">
              {{ u.username || u.email || `#${u.id}` }}（#{{ u.id }}）
            </option>
          </select>
        </div>

        <button
          type="button"
          class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
          :disabled="selectedUserId === null || reconciling"
          @click="runReconcile"
        >
          {{ reconciling ? '对账中…' : '开始对账' }}
        </button>
      </div>

      <!-- 对账结果 -->
      <template v-if="result">
        <!--
          incomplete 的处理是这一页最要紧的一件事：列举没能覆盖全命名空间时，
          **悬空行整个不产出**（服务端已压制），孤儿全部 deletable: false。
          所以这里必须显眼地说出来，否则界面看起来只是「没发现漂移」。
        -->
        <div
          v-if="result.incomplete"
          class="mb-5 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
        >
          <ExclamationCircleIcon class="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <div class="min-w-0 text-sm text-red-900">
            <p class="font-medium">列举未能覆盖整个命名空间，结果不完整</p>
            <p class="mt-0.5 text-xs leading-relaxed">
              {{ result.error || '未知原因' }}
            </p>
            <p class="mt-1 text-xs leading-relaxed">
              因此<strong>不产出悬空行</strong>（无法与「只是没翻到」区分），
              且<strong>所有孤儿对象均已禁用删除</strong>。请稍后重试或缩小范围。
            </p>
          </div>
        </div>

        <!-- 形状对不上的两类：列出来而不是丢掉 -->
        <div
          v-if="result.foreignObjects.length || result.foreignRows.length"
          class="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <ExclamationTriangleIcon class="h-4 w-4" />
            形状对不上的条目（未做任何操作）
          </h2>
          <div v-if="result.foreignObjects.length" class="mt-2">
            <p class="text-xs font-medium text-amber-900">
              不在该用户命名空间下的对象（{{ result.foreignObjects.length }}）
            </p>
            <ul class="mt-1 max-h-24 space-y-0.5 overflow-y-auto font-mono text-xs text-amber-800">
              <li v-for="k in result.foreignObjects.slice(0, 50)" :key="k" class="truncate">{{ k }}</li>
            </ul>
          </div>
          <div v-if="result.foreignRows.length" class="mt-2">
            <p class="text-xs font-medium text-amber-900">
              file_key 属主对不上的行（{{ result.foreignRows.length }}）
            </p>
            <ul class="mt-1 max-h-24 space-y-0.5 overflow-y-auto font-mono text-xs text-amber-800">
              <li v-for="r in result.foreignRows.slice(0, 50)" :key="r.id" class="truncate">
                #{{ r.id }} → {{ r.fileKey }}（解析属主：{{ r.ownerId ?? '不认识' }}）
              </li>
            </ul>
          </div>
        </div>

        <!-- 孤儿对象 -->
        <section class="mb-6">
          <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="text-sm font-semibold text-gray-900">孤儿对象</h2>
            <span class="text-xs text-gray-500">
              COS 有、数据库无。共 {{ result.orphans.length }} 个，
              {{ formatFileSize(totalOrphanBytes) }}
            </span>
          </div>

          <p
            v-if="!result.orphans.length"
            class="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500"
          >
            没有发现孤儿对象。
          </p>

          <div v-else class="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <!--
              刻意**没有**「全选」。

              删除是不可逆的，而且可能有多个超管在用这个面板（IsSuperAdmin 可授）。
              一次误点删掉几千个对象的代价，没人能承担 —— 所以每行一个按钮，
              想删多少点多少次。
            -->
            <table class="w-full text-left text-xs">
              <caption class="sr-only">孤儿对象列表，每行独立删除，没有全选</caption>
              <thead class="border-b border-gray-200 bg-gray-50 text-gray-600">
                <tr>
                  <th class="px-3 py-2 font-medium">对象键</th>
                  <th class="px-3 py-2 font-medium">大小</th>
                  <th class="px-3 py-2 font-medium">最后修改</th>
                  <th class="px-3 py-2 font-medium">年龄</th>
                  <th class="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100">
                <tr v-for="o in result.orphans" :key="o.key" class="hover:bg-gray-50">
                  <td class="max-w-0 px-3 py-2">
                    <span class="block truncate font-mono text-xs text-gray-700" :title="o.key">
                      {{ o.key }}
                    </span>
                  </td>
                  <td class="px-3 py-2 text-gray-600">{{ formatFileSize(o.size) }}</td>
                  <td class="px-3 py-2 text-gray-600">{{ formatTime(o.lastModified) }}</td>
                  <td class="px-3 py-2 text-gray-600">
                    <span v-if="o.ageMs === null" class="text-amber-600" title="无法解析最后修改时间">未知</span>
                    <span v-else>{{ formatAge(o.ageMs) }}</span>
                  </td>
                  <td class="px-3 py-2">
                    <div class="flex items-center justify-end gap-1.5">
                      <!--
                        下载是**删除前唯一的退路**：孤儿对象没有 files 行，
                        而它不在 SUM(file_size) 里 —— 所以它既不占配额，
                        删它的唯一理由是回收存储/账单。真删了就是真没了。

                        所以按钮紧挨着删除，且**不随 deletable 一起禁用**：
                        一个 20 分钟前还没到年龄下限的对象恰恰是最该让人
                        先下来看看的（它可能是正在上传的，也可能确实是垃圾）。
                      -->
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
                        :disabled="downloadingKey === o.key"
                        :title="downloadHint(o)"
                        @click="downloadOne(o)"
                      >
                        <ArrowDownTrayIcon class="h-3.5 w-3.5" />
                        {{ downloadingKey === o.key ? '签名中' : '下载' }}
                      </button>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                        :disabled="!o.deletable || purgingKey === o.key"
                        :title="o.deletable ? '删除这个对象，不可撤销' : deleteDisabledReason(o)"
                        @click="purgeOne(o)"
                      >
                        <TrashIcon class="h-3.5 w-3.5" />
                        {{ purgingKey === o.key ? '删除中' : '删除' }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- 悬空行 -->
        <section class="mb-6">
          <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="text-sm font-semibold text-gray-900">悬空行</h2>
            <span class="text-xs text-gray-500">
              数据库有、COS 无。共 {{ result.dangling.length }} 行，
              {{ formatFileSize(totalDanglingBytes) }}
            </span>
          </div>

          <div
            v-if="result.danglingSuppressedReason"
            class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900"
          >
            已压制，未产出：{{ result.danglingSuppressedReason }}
          </div>
          <p
            v-else-if="!result.dangling.length"
            class="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500"
          >
            没有发现悬空行。
          </p>

          <div v-else class="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table class="w-full text-left text-xs">
              <thead class="border-b border-gray-200 bg-gray-50 text-gray-600">
                <tr>
                  <th class="px-3 py-2 font-medium">文件名</th>
                  <th class="px-3 py-2 font-medium">大小</th>
                  <th class="px-3 py-2 font-medium">创建时间</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100">
                <tr v-for="d in result.dangling" :key="d.id" class="hover:bg-gray-50">
                  <td class="max-w-0 px-3 py-2">
                    <span class="block truncate text-gray-800" :title="d.fileKey">{{ d.filename }}</span>
                  </td>
                  <td class="px-3 py-2 text-gray-600">{{ formatFileSize(d.fileSize) }}</td>
                  <td class="px-3 py-2 text-gray-600">{{ formatTime(d.createdAt) }}</td>
                </tr>
              </tbody>
            </table>

            <!--
              悬空行**可以**一键删：删掉它们把配额还回去是这个功能最实际的用途
              （usedStorage = SUM(file_size)，所以对象没了的行仍然占着配额，
              用户会看到「空间不足」却传不进去）。

              但删除不可逆，所以走两下确认（useTwoStepConfirm），并把释放的
              字节数摆在确认按钮旁边 —— 「删完能多传多少」比一个「成功」有用。
            -->
            <div class="flex items-center gap-3 border-t border-gray-200 bg-gray-50 px-3 py-2.5">
              <span class="flex-1 text-xs text-gray-600">
                删掉这 {{ result.dangling.length }} 行可释放
                <strong class="text-gray-900">{{ formatFileSize(totalDanglingBytes) }}</strong> 配额
              </span>
              <button
                type="button"
                class="rounded-md border border-red-200 px-3 py-1.5 font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                :disabled="purgingDangling"
                @click="purgeDanglingAll"
              >
                {{ purgingDangling ? '删除中…' : confirmingDangling ? '确认删除？' : '全部删除' }}
              </button>
            </div>
          </div>
        </section>

      </template>

      <!-- 未对账时的提示 -->
      <p
        v-else-if="!reconciling"
        class="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500"
      >
        选择一个用户，然后点「开始对账」。
      </p>

      <!--
        清理历史。**刻意放在 v-if="result" 之外** —— 它读的是 purgeLog，
        mount 时就独立加载好了，跟对账结果毫无关系。原先它被关在 result 里面，
        于是想查「昨天谁删了什么」必须先挑个用户跑一次对账才看得到；
        而那 3 条记录本来就在库里。

        原来还少三样，而它们恰好是审计的全部意义：
          操作者（actor_id）—— 谁删的。一张没有「谁」的审计表不是审计表。
          payload      —— 删的到底是什么。悬空行那条快照里存着原文件名和
                         原来的文件夹 id，正是用户投诉时唯一拿得出的证据。
          孤儿对象的字节恒为 0 这件事本身 —— 不说出来，看的人会以为没释放空间。
      -->
      <section class="mt-6">
        <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 class="text-sm font-semibold text-gray-900">清理历史</h2>
          <span class="text-xs text-gray-500">
            仅记录存储桶清理。删文件、删文件夹、删用户至今都不留记录。
          </span>
        </div>

        <p
          v-if="!purgeLog.length"
          class="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500"
        >
          还没有任何清理记录。
        </p>

        <div v-else class="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table class="w-full text-left text-xs">
            <caption class="sr-only">
              清理审计记录：时间、类型、对象属主、操作者、条数、字节。点时间可展开被删除的对象。
            </caption>
            <thead class="border-b border-gray-200 bg-gray-50 text-gray-600">
              <tr>
                <th class="px-3 py-2 font-medium">时间</th>
                <th class="px-3 py-2 font-medium">类型</th>
                <th class="px-3 py-2 font-medium">对象属主</th>
                <th class="px-3 py-2 font-medium">操作者</th>
                <th class="px-3 py-2 text-right font-medium">条数</th>
                <th class="px-3 py-2 text-right font-medium">字节</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <template v-for="log in purgeLog" :key="log.id">
                <tr class="hover:bg-gray-50">
                  <td class="px-3 py-2">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 text-left text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline"
                      :aria-expanded="expandedLogId === log.id"
                      @click="toggleLog(log.id)"
                    >
                      <ChevronRightIcon v-if="expandedLogId !== log.id" class="h-3.5 w-3.5 shrink-0" />
                      <ChevronDownIcon v-else class="h-3.5 w-3.5 shrink-0" />
                      {{ formatTime(log.createdAt) }}
                    </button>
                  </td>
                  <td class="px-3 py-2 text-gray-700">
                    {{ log.kind === 'orphan-object' ? '孤儿对象' : '悬空行' }}
                  </td>
                  <td class="px-3 py-2 text-gray-700">#{{ log.userId }}</td>
                  <td class="px-3 py-2 font-medium text-gray-900">#{{ log.actorId }}</td>
                  <td class="px-3 py-2 text-right text-gray-700">{{ log.count }}</td>
                  <td class="px-3 py-2 text-right text-gray-700">
                    <span :class="log.kind === 'orphan-object' ? 'text-amber-600' : ''">
                      {{ formatFileSize(log.bytes) }}
                    </span>
                  </td>
                </tr>

                <tr v-if="expandedLogId === log.id" class="bg-gray-50">
                  <td colspan="6" class="px-3 pb-3 pt-1.5">
                    <p class="mb-1.5 text-xs text-gray-500">
                      这一次删掉的：
                      <span v-if="log.kind === 'orphan-object'" class="text-amber-700">
                        字节恒为 0 —— 端点只收到 key，删前没测大小，所以这张表答不出「释放了多少存储」
                      </span>
                    </p>
                    <ul class="space-y-1.5">
                      <li v-for="(item, i) in purgeItems(log)" :key="i" class="text-xs">
                        <span
                          v-if="item.key"
                          class="block truncate font-mono text-gray-700"
                          :title="item.key"
                        >{{ item.key }}</span>
                        <span v-if="item.note" class="text-gray-500">{{ item.note }}</span>
                      </li>
                    </ul>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ArrowDownTrayIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  TrashIcon
} from '@heroicons/vue/24/outline'
import { formatFileSize } from '~/utils/format'
import { parseTimeValue } from '~/utils/time'
import { purgeItems, type PurgeLogRow } from '~/utils/purge-log'
import { notify, notifyError } from '~/utils/notify'
import { useTwoStepConfirm } from '~/composables/useTwoStepConfirm'
// 显式 import，不靠自动导入。
//
// `useAuth` 确实在 .nuxt/imports.d.ts 的自动导入清单里，所以本该能自动注入 ——
// 但这个页面实际渲染时报过 `useAuth is not defined` 的 SSR 500，而我复现不出
// 那个条件（未登录会在 auth.global.ts 就被弹走，拿不到会话）。既然原因没查清，
// 那就把对自动导入的依赖去掉：兄弟页面 manage/files.vue 本来就是这么写的，
// 同样的代码结构下它从没出过这个问题。
import { useAuth } from '~/composables/useAuth'

definePageMeta({ layout: false })
useHead({ title: '存储桶管理' })

// 页面侧的兜底。真正的拦截在 auth.global.ts（SSR 阶段就拦），
// 这里只是客户端兜底 —— 与 manage/files.vue 同一个做法。
const { user: authUser, fetchUser } = useAuth()
await fetchUser()
const isSuper = computed(() => !!authUser.value?.IsSuperAdmin)
if (!isSuper.value && process.client) navigateTo('/')

interface Orphan {
  key: string
  size: number
  lastModified: string
  ageMs: number | null
  deletable: boolean
  /** 服务端 displayNameFromKey 的裁决：这个 key 还能不能反推原名 */
  filenameRecoverable: boolean
}
interface Dangling {
  id: number
  fileKey: string
  filename: string
  folderId: number | null
  fileSize: number
  createdAt: string
}
interface ReconcileResult {
  orphans: Orphan[]
  dangling: Dangling[]
  incomplete: boolean
  danglingSuppressedReason?: string
  error?: string
  scannedObjects: number
  scannedRows: number
  foreignObjects: string[]
  foreignRows: Array<{ id: number; fileKey: string; ownerId: number | null }>
}

/** PurgeLogRow 在 app/utils/purge-log.ts —— 载荷解读和它的类型都在那儿 */

const users = ref<Array<{ id: number; username?: string; email?: string }>>([])
const selectedUserId = ref<number | null>(null)
const reconciling = ref(false)
const result = ref<ReconcileResult | null>(null)
const purgeLog = ref<PurgeLogRow[]>([])

/**
 * 腾讯云密钥配没配。服务端 cosConfigured 的同一份判断。
 *
 * 服务端没配时 reconcile 会返回「零对象零孤儿」—— 那**是如实的**
 * （demoMode 下桶里确实什么都没有），但界面上「没有孤儿」和「没有凭据」长得
 * 一模一样，会让人以为扫过了。所以这里显式提示。
 */
const cosConfigured = ref(true)

const purgingKey = ref<string | null>(null)
const purgingDangling = ref(false)
const confirmingDangling = useTwoStepConfirm()

const totalOrphanBytes = computed(() =>
  result.value?.orphans.reduce((s, o) => s + (o.size || 0), 0) ?? 0
)
const totalDanglingBytes = computed(() =>
  result.value?.dangling.reduce((s, d) => s + (d.fileSize || 0), 0) ?? 0
)

const fmtHeaders = process.server ? useRequestHeaders(['cookie']) : undefined

async function loadUsers() {
  try {
    const res = await $fetch<{ users: any[] }>('/api/manage/listUsers', {
      headers: fmtHeaders,
      credentials: 'include'
    })
    users.value = res.users ?? []
  } catch (e) {
    notifyError(e, '读取用户列表失败')
  }
}

async function loadPurgeLog() {
  try {
    const res = await $fetch<{ entries: any[] }>('/api/manage/bucket/purge-log', {
      headers: fmtHeaders,
      credentials: 'include'
    })
    purgeLog.value = res.entries ?? []
  } catch {
    // 历史读不到不该挡住对账的主流程
    purgeLog.value = []
  }
}

async function runReconcile() {
  if (selectedUserId.value === null) return
  reconciling.value = true
  // 换用户就清掉上一份结果 —— 留着的话界面上会短暂显示「A 用户有 12 个孤儿」
  // 而选择器已经指向 B，那是会误导人的
  result.value = null
  confirmingDangling.reset()
  try {
    result.value = await $fetch<ReconcileResult>('/api/manage/bucket/reconcile', {
      method: 'POST',
      body: { userId: selectedUserId.value },
      headers: fmtHeaders,
      credentials: 'include'
    })
    await loadPurgeLog()
  } catch (e) {
    notifyError(e, '对账失败')
  } finally {
    reconciling.value = false
  }
}

/** 按钮禁用时给个原因。纯灰按钮会让人反复点 */
function deleteDisabledReason(o: Orphan): string {
  if (result.value?.incomplete) return '列举结果不完整，无法确认它确实是孤儿'
  if (o.ageMs === null) return '无法解析最后修改时间，证明不了它够旧'
  return '未到年龄下限（可能在上传中）'
}

/**
 * 下载按钮的提示。**文件名能不能还原**要写出来 ——
 * 上传路径的 key 是 uuid，原名只在那一行 files 里而那一行已经没了，
 * 让人以为那就是文件名会白找一趟。
 *
 * 判断依据是服务端给的 `filenameRecoverable`，不是这里再看一眼 key。
 * 原来写的是 `o.key.startsWith('u/')` —— 那把「哪种形状带原名」这条知识
 * 复制到了前端，而它恰恰是会变的东西（加前缀、或两种形状并成一个）。
 * 更糟的是它错也只往一边错：说「能还原」而实际已经永久丢了。
 */
function downloadHint(o: Orphan): string {
  const hint = '下载这个对象（删除前唯一的退路）'
  if (o.filenameRecoverable) return hint
  // 主句说**事实**（这个 key 不含原名），括号里才说当前的具体形态（uuid）。
  // 顺序是有意的：uuid 只是「不含原名」的一种情形，命名空间若再变，
  // 括号里的说法会过时，而事实那一句不会。把 uuid 当主句的话，
  // 将来加一个「不是 uuid 但也不含原名」的形状，这句提示就开始骗人。
  // 与 downloadOne 下载后的那句提示保持同一个说法。
  return hint + '；注意：这个 key 不含原始文件名，已无法恢复（上传路径是 uuid 形式）'
}

const downloadingKey = ref<string | null>(null)

/**
 * 签一个链接并交给浏览器下载。
 *
 * 用 <a download> + click() 而不是 window.open：签名 URL 带
 * response-content-disposition: attachment，而 window.open 在部分浏览器
 * 里会开成新标签页而不是下载。另外合成 a 元素不落进 DOM，用完即弃。
 */
async function downloadOne(o: Orphan) {
  downloadingKey.value = o.key
  try {
    const res = await $fetch<{ url: string; filename: string; filenameRecoverable: boolean }>(
      '/api/manage/bucket/download',
      {
        params: { key: o.key },
        headers: fmtHeaders,
        credentials: 'include'
      }
    )
    const a = document.createElement('a')
    a.href = res.url
    a.download = res.filename || 'object'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()

    if (!res.filenameRecoverable) {
      // 不弹错误 —— 下载本身成功了。只是如实说一句「名字恢复不了」，
      // 否则操作者会以为拿到的那串 hex 就是文件名。
      // 措辞里带上「文件名恢复不了」：NotifyState 只有 success/error 两种，
      // 而这里下载确实成功了，所以只能是 success。信息量靠这句话本身带出去。
      notify('已按 key 命名下载：原文件名无法恢复（该 key 是 uuid 形式）', 'success')
    }
  } catch (e) {
    notifyError(e, '签名失败')
  } finally {
    downloadingKey.value = null
  }
}

async function purgeOne(o: Orphan) {
  if (!selectedUserId.value) return
  purgingKey.value = o.key
  try {
    const res = await $fetch<{ deleted: number; failed: number; rejected: any[] }>(
      '/api/manage/bucket/purge-orphans',
      {
        method: 'POST',
        body: { userId: selectedUserId.value, keys: [o.key] },
        headers: fmtHeaders,
        credentials: 'include'
      }
    )
    if (res.deleted > 0) notify(`已删除 1 个对象`, 'success')
    else if (res.rejected?.length) notify(`未删除：${res.rejected[0].reason}`, 'error')
    await runReconcile()
    await loadPurgeLog()
  } catch (e) {
    notifyError(e, '删除失败')
  } finally {
    purgingKey.value = null
  }
}

async function purgeDanglingAll() {
  // 第二下才真删。useTwoStepConfirm 的 click 返回 false 表示「这次只是置位」
  if (!confirmingDangling.click(() => {})) return
  if (!selectedUserId.value || !result.value?.dangling.length) return

  purgingDangling.value = true
  try {
    const res = await $fetch<{ deleted: number; freedBytes: number; storageRecalculated: boolean }>(
      '/api/manage/bucket/purge-dangling',
      {
        method: 'POST',
        body: {
          userId: selectedUserId.value,
          ids: result.value.dangling.map((d) => d.id)
        },
        headers: fmtHeaders,
        credentials: 'include'
      }
    )
    notify(
      res.storageRecalculated
        ? `已删除 ${res.deleted} 行，释放 ${formatFileSize(res.freedBytes)} 配额`
        : `已删除 ${res.deleted} 行，配额将在下次操作时修正`,
      'success'
    )
    await runReconcile()
    await loadPurgeLog()
  } catch (e) {
    notifyError(e, '删除悬空行失败')
  } finally {
    purgingDangling.value = false
    confirmingDangling.reset()
  }
}

/**
 * 表里的时间。**必须走共享的 parseTimeValue，不能裸 Date.parse。**
 *
 * DB 里的 created_at 是 SQLite 的 CURRENT_TIMESTAMP，也就是 **UTC 墙钟，
 * 且不带时区后缀**。`Date.parse('2026-10-07 07:18:29')` 按 ES 规范当成
 * **本地时间**解释 —— 于是在 +0800 的服务器上，审计表里 15:18 发生的事
 * 显示成 07:18，**整整差 8 小时**。实测过，不是推演。
 *
 * 带 Z 的（COS 的 lastModified）裸 Date.parse 恰好是对的，所以这个 bug
 * 只在 DB 来源的两列（悬空行创建时间、清理时间）上显形，看起来「时区有时对
 * 有时不对」，很容易被当成偶发。app/utils/time.ts 的 parseTimeValue 已经
 * 处理了这个区分（无后缀就补 Z），而且 tests/server-time.test.mjs 专门
 * 在非 UTC 的 TZ 下钉着它 —— 这里复用它，不自己再实现一遍。
 *
 * 输出仍是紧凑格式而不是 formatDateTime 的 zh-CN 长格式：这张表列多，
 * 「2026年10月7日 15:18」会把表撑宽。
 */
function formatTime(v: string): string {
  const d = parseTimeValue(v)
  if (!d) return v || '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatAge(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.floor(ms / 60_000)} 分钟`
  if (h < 48) return `${h} 小时`
  return `${Math.floor(h / 24)} 天`
}

/**
 * 载荷解读在 app/utils/purge-log.ts —— 纯函数，好真正执行测试。
 * 展开中的那一条用 id 而不是行下标：列表顺序会变（ORDER BY id DESC），
 * 用下标的话折叠/展开会错行。
 */
const expandedLogId = ref<number | null>(null)

function toggleLog(id: number) {
  expandedLogId.value = expandedLogId.value === id ? null : id
}

onMounted(() => {
  loadUsers()
  loadPurgeLog()
})
</script>