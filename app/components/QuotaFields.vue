<!--
  额度与到期时间的三个输入块（到期时间 / 容量 / 下载），v-model 直接绑一个草稿对象。

  抽出来是因为有两个弹窗要用同一套：管理员的「用户管理」和主账号的「子账户」。
  抄一份的代价不只是 HTML —— 「0 表示不限」这个约定、@blur 的归一化、
  单位解析（10GB → 字节）都要跟着抄，而漏改一处不报错，只是用户填的
  10 GB 变成 10 字节。这类洞只有在真实数据变大小时才暴露。

  字段名与 users 表一致，序列化时不用做名字转换。
-->
<template>
  <div :class="readOnly ? 'opacity-60' : ''">
    <!-- 套餐过期时间 -->
    <div>
      <label class="mb-2 block text-xs font-medium uppercase tracking-wider text-gray-500">
        套餐过期时间
      </label>
      <input
        v-model="draft.expire_at"
        type="datetime-local"
        step="1"
        :disabled="readOnly"
        class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
        title="选择日期时间；清空表示不过期"
        @blur="normalizeExpire"
      />
      <p class="mt-1.5 text-xs text-gray-400">清空表示永不过期</p>
    </div>

    <!-- 容量 -->
    <div class="mt-4">
      <p class="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">容量</p>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="mb-1 block text-xs text-gray-500" :for="`maxStorage-${draft.id}`">限制</label>
          <input
            :id="`maxStorage-${draft.id}`"
            v-model="draft.maxStorage"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :disabled="readOnly"
            class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
            placeholder="如 10 GB"
            title="支持单位：B, KB, MB, GB, TB；填 0 表示不限"
            @blur="normalizeSize('maxStorage')"
          />
        </div>
        <div v-if="showUsed">
          <label class="mb-1 block text-xs text-gray-500" :for="`usedStorage-${draft.id}`">已使用</label>
          <input
            :id="`usedStorage-${draft.id}`"
            v-model="draft.usedStorage"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :disabled="readOnly || usedReadOnly"
            class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
            placeholder="如 512 MB"
            title="支持单位：B, KB, MB, GB, TB"
            @blur="normalizeSize('usedStorage')"
          />
          <p v-if="usedReadOnly" class="mt-1.5 text-xs text-gray-400">
            由实际文件自动统计
          </p>
        </div>
      </div>
    </div>

    <!-- 下载 -->
    <div class="mt-4">
      <p class="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">下载</p>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="mb-1 block text-xs text-gray-500" :for="`maxDownload-${draft.id}`">限制</label>
          <input
            :id="`maxDownload-${draft.id}`"
            v-model="draft.maxDownload"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :disabled="readOnly"
            class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
            placeholder="如 100 GB"
            title="支持单位：B, KB, MB, GB, TB；填 0 表示不限"
            @blur="normalizeSize('maxDownload')"
          />
        </div>
        <div v-if="showUsed">
          <label class="mb-1 block text-xs text-gray-500" :for="`usedDownload-${draft.id}`">已使用</label>
          <input
            :id="`usedDownload-${draft.id}`"
            v-model="draft.usedDownload"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :disabled="readOnly || usedReadOnly"
            class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-gray-50"
            placeholder="如 1.5 GB"
            title="支持单位：B, KB, MB, GB, TB"
            @blur="normalizeSize('usedDownload')"
          />
          <p v-if="usedReadOnly" class="mt-1.5 text-xs text-gray-400">
            由下载自动累计
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatBytes, parseBytes } from '~/utils/size'
import { parseExpireAt } from '~/utils/datetimeLocal'

type SizeKey = 'maxStorage' | 'usedStorage' | 'maxDownload' | 'usedDownload'

/** 至少要有这三个字段才能渲染（其余字段类型上宽松） */
export interface QuotaDraft {
  id: number
  maxStorage: number | string
  usedStorage: number | string
  maxDownload: number | string
  usedDownload: number | string
  expire_at: string | null
}

const props = withDefaults(defineProps<{
  readOnly?: boolean
  /** 显示「已使用」两列。关掉就只剩两个「限制」输入 */
  showUsed?: boolean
  /**
   * 「已使用」只读。
   *
   * 管理员在用户管理里可以直接改这个数字（有用：迁移遗留数据时对账）。
   * 但主账号的子账户弹窗里必须只读 —— 那里改写了也存不进去，
   * 给一个可编辑但无效的输入框，比不给更糟。
   */
  usedReadOnly?: boolean
}>(), { readOnly: false, showUsed: true, usedReadOnly: false })

const draft = defineModel<QuotaDraft>({ required: true })

function normalizeSize(key: SizeKey) {
  if (!draft.value) return
  draft.value[key] = formatBytes(parseBytes(draft.value[key] as string | number))
}

/**
 * blur 时只做**格式校验 + 补秒**，不做时区转换。
 *
 * 以前这里调 fromDatetimeLocal 再把结果写回 v-model，于是用户输入的本地墙钟
 * 被减掉 TimeZone 偏移后**直接显示在输入框里** —— 填「明天 9 点」，松手变成
 * 「明天 1 点」。时区转换只在保存时做一次（父组件的 submit），输入框里始终
 * 是用户填的本地时间。
 *
 * 秒位要先补再校验：datetime-local 在没碰秒的时候给的是 "2027-01-01T09:00"，
 * 而 parseExpireAt 的正则要求 6 段（含秒）。不补就等于把用户刚填的值判成非法
 * 然后清空 —— 表现就是「改了没反应」。
 *
 * 真正解析不出来就清空：留着一个非法串进去，保存时服务端 isSqlDateTimeString
 * 会拒，而用户看到的是「点了保存没反应」，比当场清空更难查。
 */
function normalizeExpire() {
  if (!draft.value) return
  const raw = (draft.value.expire_at ?? '').toString().trim()
  if (!raw) {
    draft.value.expire_at = ''
    return
  }
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw
  if (!parseExpireAt(withSeconds)) {
    draft.value.expire_at = ''
    return
  }
  draft.value.expire_at = withSeconds
}
</script>