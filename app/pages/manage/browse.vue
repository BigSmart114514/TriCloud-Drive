<template>
  <div class="min-h-screen bg-gray-50">
    <!--
      骨架与 manage/bucket.vue 同层：layout: false（auth.global.ts 在 SSR 阶段
      就拦掉非超管），顶栏自己放 AppNavbar —— 本项目没有 app/layouts/，
      Navbar 不由 layout 提供。理由与踩过的坑见 bucket.vue 里那段注释。
    -->
    <AppNavbar />

    <header class="border-b border-gray-200 bg-white">
      <div class="mx-auto flex max-w-7xl items-center gap-3 py-3 sm:px-6 lg:px-8">
        <div class="min-w-0 flex-1">
          <h1 class="flex items-center gap-1.5 text-base font-semibold text-gray-900">
            <FolderOpenIcon class="h-5 w-5 shrink-0 text-gray-500" />
            对象浏览
          </h1>
          <p class="mt-0.5 text-xs text-gray-500">
            浏览器里的对象。
          </p>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <!-- 没配腾讯云密钥 -->
      <div
        v-if="page && !page.cosConfigured"
        class="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
      >
        <ExclamationTriangleIcon class="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div class="text-sm text-amber-900">
          <p class="font-medium">未配置腾讯云密钥</p>
          <p class="mt-0.5 text-xs leading-relaxed">
            这里列不出东西。配置好密钥后才能看到桶里的内容。
          </p>
        </div>
      </div>

      <!--
        控制条。

        前缀是**自由文本**，这是刻意的：能进这一页的是超管，秘钥就在服务端
        配置里，他本来就能对整个桶做任何事。为看一个对象而要求先选中用户、
        再从两个命名空间里挑一个，是把限制加在错的地方。

        所以代价落在「别看错范围」上，而这个界面上唯一管得住它的就是下面那行
        **完整显示的前缀** —— 不是「用户 2 的文件」这种转述。
      -->
      <section class="mb-5 rounded-xl border border-gray-200 bg-white p-4">
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-0 flex-1">
            <label for="browse-prefix" class="mb-1.5 block text-xs font-medium text-gray-700">
              前缀
            </label>
            <input
              id="browse-prefix"
              v-model="prefixInput"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="留空 = 整个桶"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm text-gray-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              @keyup.enter="runBrowse(true)"
            />
          </div>

          <div class="min-w-0 flex-1">
            <label for="browse-user" class="mb-1.5 block text-xs font-medium text-gray-700">
              用户
            </label>
            <select
              id="browse-user"
              v-model="selectedUserId"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              <option :value="null">全部</option>
              <option v-for="u in users" :key="u.id" :value="u.id">
                {{ u.username || u.email || `#${u.id}` }}（#{{ u.id }}）
              </option>
            </select>
          </div>

          <label class="flex items-center gap-2 pb-2 text-sm text-gray-700">
            <input
              v-model="groupByDir"
              type="checkbox"
              class="h-4 w-4 shrink-0 rounded border-gray-300 text-indigo-600"
            />
            按目录分组
          </label>

          <button
            type="button"
            class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
            :disabled="loading"
            @click="runBrowse(true)"
          >
            {{ loading ? '列举中…' : '列出' }}
          </button>
        </div>

        <!--
          快捷方式。**全部来自响应里的 allPrefixes**，不在这一页推算命名空间 ——
          那条知识在 server/utils/file-key.ts 的 FILE_KEY_PREFIXES，复制一份
          就会分叉（b5c74a8 记的就是这个：downloadHint 在前端自己判 key 形状，
          后果是只往「说能还原」那一侧错）。
        -->
        <div v-if="allPrefixes.length" class="mt-3 flex flex-wrap items-center gap-1.5">
          <span class="text-xs text-gray-500">快捷</span>
          <button
            type="button"
            class="rounded-md border border-gray-200 px-2 py-1 font-mono text-xs text-gray-700 transition-colors hover:bg-gray-100"
            :class="{ 'border-indigo-300 bg-indigo-50 text-indigo-700': prefixInput === '' }"
            @click="jumpToPrefix('')"
          >
            整个桶
          </button>
          <button
            v-for="p in allPrefixes"
            :key="p"
            type="button"
            class="rounded-md border border-gray-200 px-2 py-1 font-mono text-xs text-gray-700 transition-colors hover:bg-gray-100"
            :class="{ 'border-indigo-300 bg-indigo-50 text-indigo-700': prefixInput === p }"
            @click="jumpToPrefix(p)"
          >
            {{ p }}
          </button>
        </div>
      </section>

      <!-- 当前范围：放开前缀之后，这是界面上唯一的护栏 -->
      <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span class="text-gray-500">当前路径</span>
        <code
          class="max-w-full truncate rounded bg-gray-800 px-1.5 py-0.5 font-mono text-xs text-gray-100"
          :title="displayedPrefix"
        >{{ displayedPrefix }}</code>
        <button
          v-if="prefixInput"
          type="button"
          class="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-100"
          @click="goUp"
        >
          <ArrowUpIcon class="h-3.5 w-3.5 shrink-0" />
          上一级
        </button>
      </div>

      <!--
        部分列举失败。listCosObjectsPage 可能在拿到一部分结果的同时带上 error。
        界面上把它当「空」显示就是在说谎 —— 而这一页默认列的是整个桶。
      -->
      <div
        v-if="page && page.error"
        class="mb-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
      >
        <ExclamationCircleIcon class="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
        <div class="min-w-0 text-sm text-red-900">
          <p class="font-medium">没能列全，下面不是全部。</p>
          <p class="mt-0.5 text-xs leading-relaxed">{{ page.error }}</p>
          <p class="mt-1 text-xs leading-relaxed">
            所以「0 个对象」不代表这里真的空着。换个前缀再试。
          </p>
        </div>
      </div>

      <!-- 结果 -->
      <template v-if="page">
        <p
          v-if="!page.objects.length && !page.commonPrefixes.length"
          class="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500"
        >
          这里没有对象。
        </p>

        <div
          v-else
          class="overflow-hidden rounded-lg border border-gray-200 bg-white"
        >
          <table class="w-full text-left text-xs">
            <caption class="sr-only">
              对象列表。目录可点开，对象可下载。
            </caption>
            <thead class="border-b border-gray-200 bg-gray-50 text-gray-600">
              <tr>
                <th class="px-3 py-2 font-medium">对象键</th>
                <th class="px-3 py-2 font-medium">大小</th>
                <th class="px-3 py-2 font-medium">最后修改</th>
                <th class="px-3 py-2 font-medium">存储类型</th>
                <th class="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <!-- 目录。有 commonPrefixes 才会有这一批（group=dir） -->
              <tr v-for="d in page.commonPrefixes" :key="d" class="bg-gray-50/60 hover:bg-gray-100">
                <td class="max-w-0 px-3 py-2" colspan="4">
                  <button
                    type="button"
                    class="flex min-w-0 items-center gap-1.5 text-left font-mono text-xs text-indigo-700 hover:underline"
                    :title="d"
                    @click="enterDir(d)"
                  >
                    <FolderIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="truncate">{{ d }}</span>
                  </button>
                </td>
                <td class="px-3 py-2"></td>
              </tr>

              <tr v-for="o in page.objects" :key="o.key" class="hover:bg-gray-50">
                <td class="max-w-0 px-3 py-2">
                  <span class="block truncate font-mono text-xs text-gray-700" :title="o.key">
                    {{ o.key }}
                  </span>
                </td>
                <td class="px-3 py-2 text-gray-600">{{ formatFileSize(o.size) }}</td>
                <td class="px-3 py-2 text-gray-600">{{ formatTime(o.lastModified) }}</td>
                <td class="px-3 py-2 text-gray-600">
                  <span v-if="o.storageClass !== 'STANDARD'" class="text-amber-700">
                    {{ o.storageClass }}
                  </span>
                  <span v-else class="text-gray-400">—</span>
                </td>
                <td class="px-3 py-2">
                  <div class="flex items-center justify-end">
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
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!--
          分页。COS 的 marker 是**不透明游标**，没有「上一页」这个 API ——
          只能自己把走过的 marker 存一路，退回来时把栈顶弹掉重列。
          所以这两个按钮的状态是相反的：下一页看 truncated，上一页看栈深。
        -->
        <div class="mt-3 flex items-center gap-2 text-xs">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
            :disabled="!canGoPrev"
            @click="goPrevPage"
          >
            <ChevronLeftIcon class="h-3.5 w-3.5 shrink-0" />
            上一页
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
            :disabled="!page.truncated"
            @click="goNextPage"
          >
            下一页
            <ChevronRightIcon class="h-3.5 w-3.5 shrink-0" />
          </button>
          <span class="text-gray-500">第 {{ pageNo }} 页</span>
        </div>
      </template>

      <p
        v-else
        class="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500"
      >
        输入前缀，或留空看整个桶。
      </p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ArrowDownTrayIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  FolderOpenIcon
} from '@heroicons/vue/24/outline'
import { formatFileSize } from '~/utils/format'
import { parseTimeValue } from '~/utils/time'
import { notify, notifyError } from '~/utils/notify'
// 显式 import，不靠自动导入 —— 与 manage/ 其余页一致。理由见 bucket.vue 里
// 那段注释（自动导入注入失败过一次，代价是 SSR 500，而原因至今没查清）。
import { useAuth } from '~/composables/useAuth'

definePageMeta({ layout: false })
useHead({ title: '对象浏览' })

// 页面侧的兜底。真正的拦截在 auth.global.ts（SSR 阶段就拦）。
const { user: authUser, fetchUser } = useAuth()
await fetchUser()
const isSuper = computed(() => !!authUser.value?.IsSuperAdmin)
if (!isSuper.value && process.client) navigateTo('/')

interface BrowseObject {
  key: string
  size: number
  lastModified: string
  etag: string
  storageClass: string
}
interface BrowsePage {
  prefix: string
  objects: BrowseObject[]
  commonPrefixes: string[]
  truncated: boolean
  nextMarker: string | null
  error?: string
  /** 服务端给的命名空间快捷方式。这里**只**用它，不自己推算 —— 见模板里的注释 */
  allPrefixes: string[]
  cosConfigured: boolean
}

const users = ref<Array<{ id: number; username?: string; email?: string }>>([])
const selectedUserId = ref<number | null>(null)
const prefixInput = ref('')
const groupByDir = ref(true)
const loading = ref(false)
const page = ref<BrowsePage | null>(null)
const downloadingKey = ref<string | null>(null)

/**
 * 游标栈。
 *
 * COS 的 marker 是不透明游标，**只能向前**：没有「上一页」这种 API。
 * 所以退回去只能靠自己记：进一页就把上一页的 marker 压栈，返回时弹掉栈顶
 * 再重列一遍。栈底那个 undefined 是第一页（不带 Marker）。
 */
const markerStack = ref<Array<string | undefined>>([undefined])

const canGoPrev = computed(() => markerStack.value.length > 1)
const pageNo = computed(() => markerStack.value.length)

/** 快捷前缀只认响应给的那份 */
const allPrefixes = computed(() => page.value?.allPrefixes ?? [])

/**
 * 当前范围的显示。
 *
 * 空前缀在界面上**不能显示成空白** —— 一片空白读起来像「没在列任何东西」，
 * 而它的真实含义是「整个桶」。这一页默认就是空前缀，所以这个换算不是装饰。
 */
const displayedPrefix = computed(() => (page.value ? page.value.prefix || '整个桶' : prefixInput.value || '整个桶'))

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

/**
 * 列一页。
 *
 * `resetCursor` = true 时从第一页重新开始（换前缀、换分组方式、点「列出」）。
 * 为 false 时沿用游标栈顶 —— 翻页与「上一级」之后走的是这条。
 */
async function runBrowse(resetCursor = false) {
  if (loading.value) return
  if (resetCursor) markerStack.value = [undefined]
  loading.value = true
  // 请求前清掉上一份结果。留着的话，输入框已经指向 B 而表格还显示着 A 的
  // 那 100 个 key —— 那是在骗人。
  page.value = null
  try {
    page.value = await $fetch<BrowsePage>('/api/manage/bucket/browse', {
      params: {
        prefix: prefixInput.value,
        // 分组方式换了就得从头列：同一页在两种 delimiter 下的内容不同，
        // 游标更是来自另一个列举序列，混用会跳过或重复条目。
        group: groupByDir.value ? 'dir' : undefined,
        marker: markerStack.value[markerStack.value.length - 1],
        userId: selectedUserId.value ?? undefined
      },
      headers: fmtHeaders,
      credentials: 'include'
    })
    // 服务端回显的才是真正列了的范围（回显优先于输入框，避免两者不一致时
    // 界面上显示的是一个没被列的字符串）
    prefixInput.value = page.value.prefix
  } catch (e) {
    notifyError(e, '列举失败')
  } finally {
    loading.value = false
  }
}

/** 点快捷前缀（含「整个桶」）。换范围 ⇒ 游标归零 */
function jumpToPrefix(p: string) {
  prefixInput.value = p
  runBrowse(true)
}

/**
 * 进子目录。
 *
 * 必须同时换掉前缀**并**清掉游标：游标来自上一个列举序列，范围一换，
 * 带着它翻页会跳到不相干的位置（或者干脆列不出来）。
 */
function enterDir(dir: string) {
  prefixInput.value = dir
  markerStack.value = [undefined]
  runBrowse(false)
}

/** 上一级：砍掉最后一段。末尾的斜杠要留着 —— 少一个斜杠就换了一个前缀 */
function goUp() {
  const trimmed = prefixInput.value.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  prefixInput.value = at > 0 ? trimmed.slice(0, at + 1) : ''
  runBrowse(true)
}

function goNextPage() {
  if (!page.value?.truncated || !page.value.nextMarker) return
  markerStack.value.push(page.value.nextMarker)
  runBrowse(false)
}

function goPrevPage() {
  if (!canGoPrev.value) return
  markerStack.value.pop()
  runBrowse(false)
}

/** 下载按钮的提示。说法与存储桶管理页一致：先说事实，当前形态只放括号里 */
function downloadHint(o: BrowseObject): string {
  const hint = '下载这个对象'
  if (o.key.includes('/') && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(basename(o.key))) {
    // 旧命名空间把原名放在 key 里，新的是 uuid。这里不自己判「哪种形状带原名」
    // —— 那是服务端 displayNameFromKey 的裁决，而这一页不下结论，
    // 只把两种可能都提示出来，让下载后的结果自己说明问题。
    return hint + '；若下载到的文件名是一串名字而非原名，说明该 key 不含原始文件名'
  }
  return hint
}

function basename(key: string): string {
  const i = key.lastIndexOf('/')
  return i < 0 ? key : key.slice(i + 1)
}

/**
 * 下载。与存储桶管理页共用 /api/manage/bucket/download —— 签名逻辑只有那一份。
 *
 * 这里**刻意**没有把两页的下载抽成共用函数：bucket.vue 的下载有 6 条测试直接
 * 断言在它的模板与 script 上（tests/bucket-download.test.mjs），抽走就得连
 * 那些断言一起搬。为省 20 行重复去动一份已钉住的页面不划算。
 */
async function downloadOne(o: BrowseObject) {
  downloadingKey.value = o.key
  try {
    const res = await $fetch<{ url: string; filename: string; filenameRecoverable: boolean }>(
      '/api/manage/bucket/download',
      { params: { key: o.key }, headers: fmtHeaders, credentials: 'include' }
    )
    const a = document.createElement('a')
    a.href = res.url
    a.download = res.filename || 'object'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (e) {
    notifyError(e, '签名失败')
  } finally {
    downloadingKey.value = null
  }
}

/**
 * COS 的 lastModified 带 Z，裸 Date.parse 恰好是对的；但统一走 parseTimeValue，
 * 免得这一页以后混进 DB 来源的时间列时又踩 UTC 墙钟那个 8 小时（b5c74a8）。
 */
function formatTime(v: string): string {
  const d = parseTimeValue(v)
  if (!d) return v || '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(() => {
  loadUsers()
})
</script>
