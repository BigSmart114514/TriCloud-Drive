<script setup lang="ts">
import { computed } from 'vue'

type Category =
  | 'pdf' | 'word' | 'excel' | 'ppt'
  | 'image' | 'video' | 'audio'
  | 'archive' | 'code' | 'txt'
  | 'json' | 'md' | 'other'

const props = withDefaults(defineProps<{
  filename?: string
  ext?: string
  showLabel?: boolean
}>(), {
  showLabel: true
})

const rawExt = computed(() => {
  const fromProp = props.ext?.trim()
  if (fromProp) return fromProp.toLowerCase()
  const name = props.filename ?? ''
  const dot = name.lastIndexOf('.')
  if (dot === -1) return ''
  return name.slice(dot + 1).toLowerCase()
})

const category = computed<Category>(() => {
  const e = rawExt.value
  if (!e) return 'other'

  const inSet = (arr: string[]) => arr.includes(e)

  if (inSet(['pdf'])) return 'pdf'
  if (inSet(['doc', 'docx', 'rtf', 'wps'])) return 'word'
  if (inSet(['xls', 'xlsx', 'csv'])) return 'excel'
  if (inSet(['ppt', 'pptx'])) return 'ppt'
  if (inSet(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff', 'ico', 'heic', 'heif', 'avif'])) return 'image'
  if (inSet(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'])) return 'video'
  if (inSet(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus'])) return 'audio'
  if (inSet(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst', 'tgz', 'lz', 'lzma', 'cab', 'iso', 'arj', 'cpio', 'rpm', 'deb', 'dmg', 'msi', 'xar', 'z'])) return 'archive'
  if (inSet(['txt', 'log', 'ini', 'conf'])) return 'txt'
  if (inSet(['json'])) return 'json'
  if (inSet(['md', 'mdx'])) return 'md'

  // 一些常见代码后缀
  if (inSet([
    'js','ts','jsx','tsx','vue','html','css','scss','less',
    'py','rb','go','rs','java','kt','swift','c','cpp','cxx','h','hpp',
    'cs','php','sh','bash','zsh','fish','sql','yml','yaml','xml','toml'
  ])) return 'code'

  return 'other'
})

const archiveLabel = computed(() => {
  if (rawExt.value === '7z') return '7Z'
  if (rawExt.value === 'rar') return 'RAR'
  if (rawExt.value === 'tar') return 'TAR'
  return 'ZIP'
})

const cfg = computed(() => {
  // 颜色使用固定 HEX，避免 Tailwind 动态类失效；文档底座使用 currentColor
  const map: Record<Category, { color: string; label: string }> = {
    pdf:    { color: '#EF4444', label: 'PDF' },
    word:   { color: '#2563EB', label: 'DOC' },
    excel:  { color: '#10B981', label: 'XLS' },
    ppt:    { color: '#F97316', label: 'PPT' },
    image:  { color: '#F59E0B', label: 'IMG' },
    video:  { color: '#06B6D4', label: 'VID' },
    audio:  { color: '#8B5CF6', label: 'AUD' },
    archive:{ color: '#A16207', label: archiveLabel.value },
    code:   { color: '#0EA5E9', label: 'CODE' },
    txt:    { color: '#9CA3AF', label: 'TXT' },
    json:   { color: '#22C55E', label: 'JSON' },
    md:     { color: '#64748B', label: 'MD' },
    other:  { color: '#6B7280', label: (rawExt.value || 'FILE').toUpperCase().slice(0, 5) }
  }
  return map[category.value]
})

/*
  说明：
  - 外层可通过 class="h-8 w-8 text-gray-400" 控制尺寸和底座颜色（currentColor）
  - 右下角 Badge 使用配置的 HEX 颜色，区分类型
*/
</script>

<template>
  <svg class="h-8 w-8" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <!-- 文档底座（使用 currentColor，完全离线） -->
    <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"
      d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
    />
    <!-- 右下角 Badge（彩色块） -->
    <rect x="9.25" y="12.4" rx="1.1" width="9.2" height="6.0" :fill="cfg.color" />
    <!-- Badge 文本（大写后缀/标签），字体尽量使用系统 UI，保证离线 -->
    <text v-if="showLabel" x="13.9" y="16.6"
      text-anchor="middle"
      font-size="3.6"
      font-weight="700"
      fill="#fff"
      style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji'">
      {{ cfg.label }}
    </text>
  </svg>
</template>