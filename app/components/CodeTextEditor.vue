<template>
  <div ref="host" class="h-full w-full overflow-hidden" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadLanguageExtension, type CodeLanguageId } from '~/utils/code-language'
import { loadCodeThemeExtension, type ResolvedCodeTheme } from '~/utils/code-theme'

/**
 * 代码编辑器。
 *
 * **CM6 只在 onMounted 里动态 import。** 静态 import 会让 codemirror、九个
 * 语言包和主题全部进入首个 chunk —— 打开首页就先下载一遍编辑器，哪怕用户
 * 从不点开代码预览。这里拆成运行时加载，打包器会把它们各切一块。
 *
 * 编辑器自己不知道「编码」这回事：parent 已经把字节解成 JS 字符串，保存时
 * 再由 parent 用选中的编码写回。所以这里只处理字符串的进与出。
 */
const props = defineProps<{
  modelValue: string
  language: CodeLanguageId
  theme: ResolvedCodeTheme
  readonly?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const host = ref<HTMLDivElement | null>(null)
let view: import('@codemirror/view').EditorView | null = null
let stateModule: typeof import('@codemirror/state') | null = null
let viewModule: typeof import('@codemirror/view') | null = null
let languageCompartment: import('@codemirror/state').Compartment | null = null
let themeCompartment: import('@codemirror/state').Compartment | null = null
let readonlyCompartment: import('@codemirror/state').Compartment | null = null
/**
 * 外部替换文档时置位，updateListener 看到它就不 emit。
 *
 * 换编码会由 parent 把 textContent 整篇换掉，watch 把它推进编辑器。如果没有
 * 这个闸门，dispatch 会再 emit 一次同样的值 —— 看起来无害，但 dirty 的比较
 * 基准是 originalContent，一次多余的 emit 会让「未保存」状态闪一下。
 */
let applyingExternal = false
let disposed = false

/** 只读必须在两层同时关：state 挡事务，view 挡光标/输入法。 */
const readonlyExtensions = (readOnly: boolean) => {
  if (!stateModule || !viewModule) return []
  return [
    stateModule.EditorState.readOnly.of(readOnly),
    viewModule.EditorView.editable.of(!readOnly)
  ]
}

onMounted(async () => {
  const [state, viewLib, setup, language, theme] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('codemirror'),
    loadLanguageExtension(props.language),
    loadCodeThemeExtension(props.theme)
  ])
  // 等 import 的这段时间里用户可能已经关掉预览：宿主没了就别再建。
  if (disposed || !host.value) return
  stateModule = state
  viewModule = viewLib
  languageCompartment = new state.Compartment()
  themeCompartment = new state.Compartment()
  readonlyCompartment = new state.Compartment()

  view = new viewLib.EditorView({
    parent: host.value,
    state: state.EditorState.create({
      doc: props.modelValue,
      extensions: [
        setup.basicSetup,
        viewLib.EditorView.lineWrapping,
        viewLib.EditorView.contentAttributes.of({ 'aria-label': '代码编辑器' }),
        languageCompartment.of(language),
        themeCompartment.of(theme),
        readonlyCompartment.of(readonlyExtensions(props.readonly === true)),
        viewLib.EditorView.updateListener.of((update) => {
          if (!update.docChanged || applyingExternal) return
          emit('update:modelValue', update.state.doc.toString())
        })
      ]
    })
  })
})

// 外部换文本（换编码、换文件）：整篇替换，且不能反过来再 emit。
watch(() => props.modelValue, (value) => {
  if (!view) return
  const current = view.state.doc.toString()
  if (current === value) return
  applyingExternal = true
  try {
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  } finally {
    applyingExternal = false
  }
})

// 换语言 / 换主题都不重建编辑器：重建会丢撤销历史与滚动位置。
watch(() => props.language, async (language) => {
  const extension = await loadLanguageExtension(language)
  if (!view || !languageCompartment) return
  view.dispatch({ effects: languageCompartment.reconfigure(extension) })
})

watch(() => props.theme, async (theme) => {
  const extension = await loadCodeThemeExtension(theme)
  if (!view || !themeCompartment) return
  view.dispatch({ effects: themeCompartment.reconfigure(extension) })
})

watch(() => props.readonly, (readOnly) => {
  if (!view || !readonlyCompartment) return
  view.dispatch({ effects: readonlyCompartment.reconfigure(readonlyExtensions(readOnly === true)) })
})

onBeforeUnmount(() => {
  disposed = true
  view?.destroy()
  view = null
})
</script>

<style scoped>
:deep(.cm-editor) {
  height: 100%;
}

:deep(.cm-editor.cm-focused) {
  outline: none;
}

:deep(.cm-scroller) {
  overflow: auto;
}
</style>
