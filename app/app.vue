<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>

  <!--
    全局「问一句」弹窗，挂一次即可。

    提问点散在 accounts.vue / manage/user.vue / FileBrowser.vue / FilePreviewer.vue
    四处，所以状态放在 usePromptDialog 的模块单例里、UI 只有这一份 ——
    做成 props 往上传就得挂四次再各写一遍接线。与 notify.ts 同一套路。

    **放在 NuxtLayout 之外**：它 Teleport 到 body，与页面层级无关；放这里是为了
    不受任何页面 layout 的 `transform` / `filter` 影响（那种祖先会把 fixed 元素
    变成相对定位，正是 SidePanelLayout 用 Teleport 绕过的那个坑）。
  -->
  <PromptDialog />
</template>

<script setup>
import PromptDialog from '~/components/PromptDialog.vue'
import { EXPERIMENTAL_UI_MODE, UI_PREFERENCES_STORAGE_KEY } from '~/composables/useUiPreferences'

useHead({
  script: [
    {
      key: 'ui-preferences-preload',
      innerHTML: `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(UI_PREFERENCES_STORAGE_KEY)})||'null');if(p&&p.experimentalUi)document.documentElement.dataset.ui=${JSON.stringify(EXPERIMENTAL_UI_MODE)}}catch(e){}`
    }
  ]
})

// 初始化时获取用户信息
const { fetchUser } = useAuth()

onMounted(() => {
  fetchUser()
})
</script>
