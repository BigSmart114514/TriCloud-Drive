<!--
  骨架屏。

  ## 它同时解决两件事

  1. 加载时有反馈（原来只有一行「正在加载用户数据...」）
  2. **占住最终高度**，数据回来时不再把下面的内容整体顶下去

  第 2 点才是主要目的。一个不占高度的加载动画只会让抖动更难看 —— 先空着、
  再突然长出来，比没有动画更糟。

  ## 颜色为什么用 bg-gray-200

  因为 experimental.css 里 `.bg-gray-200` 已经被覆盖成半透明白
  （`background-color: rgba(255,255,255,.5)` 加一道内描边）。所以同一个类在
  「液态玻璃」和默认两个主题下都成立，不必各写一套。骨架是布局占位物，不该
  自己定义颜色。

  ## reduced-motion

  animate-pulse 在 prefers-reduced-motion: reduce 下会被 base.css 的全局兜底
  压到 1ms。这里不再重复判断 —— base.css 已经管了全局，逐个变体加必然漏掉。
-->
<template>
  <div
    aria-hidden="true"
    class="animate-pulse rounded bg-gray-200"
    :class="variant === 'circle' ? 'rounded-full' : ''"
    :style="{ width, height: height ?? undefined }"
  />
</template>

<script setup lang="ts">
/**
 * variant
 *   text   文字条（列表行、段落）
 *   circle 圆（概览面板那两个环的占位）
 *
 * 尺寸走 style 而不是类名：调用点多是需要「比文字高一点」或「比整行窄一点」
 * 这种非整档的值，堆 `h-[13px] w-[62%]` 会得到一长串没有共同点的类。
 */
withDefaults(
  defineProps<{
    variant?: 'text' | 'circle'
    width?: string
    height?: string
  }>(),
  { variant: 'text', width: '100%' }
)
</script>
