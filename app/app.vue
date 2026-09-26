<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>

<script setup>
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
