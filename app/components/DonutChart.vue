<!--
  环状图。只画环，不画图例。

  ## 为什么图例不在这��件里

  用户管理那一页要并排两个环（存储 + 下载），而**同一个用户**在两个环里必须是
  同一个颜色 —— 否则一眼扫过去会以为 BigSmart 在左边是蓝色、在右边是橙色，
  是两个人。所以图例只有一份，画在两个环下面，由那一页统一配色。

  各画各的图例还有个更实际的问题：图例会重复一份用户名，而面板宽度只有半屏
  （`grid-cols-1 lg:grid-cols-2`），两个图例各自换行还不如一份。

  ## 为什么自己画

  项目没有图表库。环需要的只是「一段弧」和「按比例切」，数学在
  app/utils/donut.ts（纯函数，有真正的执行测试）。

  环形中间是空的，数值写在环下面而不是 SVG 的 <text> 里 —— SVG 里的文字不会
  自动换行、也不参与排版，字号还随 viewBox 缩放，用 DOM 文本更可控。

  空状态画一个灰圈 + 「还没有用量」。画布高度不变，否则加载完成时整个面板会
  往下跳一格。
-->
<template>
  <div class="flex min-w-0 flex-col items-center">
    <svg
      viewBox="0 0 100 100"
      class="h-28 w-28 shrink-0"
      role="img"
      :aria-label="ariaLabel"
    >
      <!--
        没有数据时画一个整圆的灰环。**不能用 arcPath 画** —— 整圆要拆成两段
        半圆，而这里要的是一个不带洞的底盘，所以直接用 circle。
      -->
      <circle v-if="!slices.length" cx="50" cy="50" r="38" class="fill-gray-100" />

      <path
        v-for="(seg, i) in segments"
        :key="seg.key"
        :d="seg.d"
        :fill="seg.color"
        opacity="0.9"
      />

      <!--
        切片之间刻意**不留缝**。常见做法是叠一圈白色描边制造分隔，但那要盖在
        整条环带上（r=(外+内)/2、线宽=外−内，正好把 26..38 全部覆盖）——
        先写过一版就是这么干的，结果把所有扇形都盖住了，白环。
        而在这份数据下留缝也不合适：最小的用户占 2.96%，再被一条描边吃掉
        一部分，它自己就不像块扇形了。
      -->
    </svg>

    <p class="mt-2 text-xs font-medium text-gray-500">{{ title }}</p>
    <p class="text-sm font-semibold text-gray-900">{{ totalText }}</p>
    <p v-if="!slices.length" class="text-xs text-gray-400">还没有用量</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { arcPath, sliceAngles, type DonutSlice } from '~/utils/donut'
import { formatFileSize } from '~/utils/format'

const props = defineProps<{
  slices: DonutSlice[]
  total: number
  title: string
  /** key → 颜色。图例在父组件，所以颜色必须由父组件给，两环才能同色 */
  colors: Record<string, string>
}>()

const OUTER = 38
const INNER = 26

const segments = computed(() => {
  const angles = sliceAngles(props.slices)
  return props.slices.map((s, i) => ({
    key: s.key,
    color: props.colors[s.key] ?? '#9ca3af',
    d: arcPath(50, 50, OUTER, INNER, angles[i].start, angles[i].end)
  }))
})

const totalText = computed(() => (props.total > 0 ? formatFileSize(props.total) : '—'))

/**
 * 无障碍描述要说清「谁占多少」，不能只有一句「环状图」——
 * 屏幕阅读器读不出扇形，于是这张图对它等于不存在。
 */
const ariaLabel = computed(() => {
  if (!props.slices.length) return `${props.title}：还没有用量`
  const parts = props.slices.map(
    (s) => `${s.label} ${formatFileSize(s.value)}，占 ${Math.round(s.share * 100)}%`
  )
  return `${props.title}，共 ${formatFileSize(props.total)}。${parts.join('；')}`
})
</script>
