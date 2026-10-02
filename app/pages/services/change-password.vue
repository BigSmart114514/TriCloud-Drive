<template>
  <AppNavbar />

  <!-- 无权限 -->
  <div
    v-if="!user?.canChangePassword"
    class="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8"
  >
    <div class="bg-yellow-50 border-l-4 border-yellow-400 p-4">
      <div class="flex">
        <div class="ml-3">
          <p class="text-sm text-yellow-700">
            当前账号没有“修改密码”的权限，请联系管理员。
          </p>
        </div>
      </div>
    </div>
  </div>

  <!-- 有权限 -->
  <div
    v-else
    class="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8"
  >
    <div class="max-w-md w-full space-y-8">
      <div>
        <h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900">
          修改密码
        </h2>
        <p class="mt-2 text-center text-sm text-gray-600">
          当前登录账号：
          <span class="font-medium text-gray-900">{{ user?.username || '未知' }}</span>
        </p>
      </div>

      <form class="mt-8 space-y-6" @submit.prevent="handleChangePassword">
        <div class="rounded-md shadow-sm -space-y-px">
          <div>
            <label for="currentPassword" class="sr-only">当前密码</label>
            <input
              id="currentPassword"
              v-model="form.currentPassword"
              name="currentPassword"
              type="password"
              autocomplete="current-password"
              required
              class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
              placeholder="当前密码"
            />
          </div>
          <div>
            <label for="newPassword" class="sr-only">新密码</label>
            <input
              id="newPassword"
              v-model="form.newPassword"
              name="newPassword"
              type="password"
              autocomplete="new-password"
              required
              class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
              placeholder="新密码（至少 8 位）"
            />
          </div>
          <div>
            <label for="confirmPassword" class="sr-only">确认新密码</label>
            <input
              id="confirmPassword"
              v-model="form.confirmPassword"
              name="confirmPassword"
              type="password"
              autocomplete="new-password"
              required
              class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
              placeholder="确认新密码"
            />
          </div>
        </div>

        <div v-if="error" class="rounded-md bg-red-50 p-4">
          <div class="flex">
            <div class="ml-3">
              <h3 class="text-sm font-medium text-red-800">
                {{ error }}
              </h3>
            </div>
          </div>
        </div>

        <div v-if="success" class="rounded-md bg-green-50 p-4">
          <div class="flex">
            <div class="ml-3">
              <h3 class="text-sm font-medium text-green-800">
                {{ success }}
              </h3>
            </div>
          </div>
        </div>

        <div>
          <button
            type="submit"
            :disabled="loading"
            class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            <span v-if="loading">提交中...</span>
            <span v-else>修改密码</span>
          </button>
        </div>
      </form>

      <p class="text-xs text-gray-500 text-center">
        密码要求：长度大于等于8位，包含数字和字母
        密码安全建议：长度 ≥ 12，包含大小写字母、数字和符号的组合。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">

import { useRouter } from 'vue-router'
import { toMessage } from '~/utils/notify'
import { isStrongPassword, PASSWORD_RULE_TEXT } from '~/utils/password'

useHead({ title: '修改密码' })
const router = useRouter()
definePageMeta({
  layout: false
})

// 你项目里已有的鉴权组合式函数
const { user, isLoggedIn } = useAuth()

if (!isLoggedIn.value) {
  await navigateTo('/login')
}

const form = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const loading = ref(false)
const error = ref('')
const success = ref('')

const validate = () => {
  if (!form.currentPassword || !form.newPassword || !form.confirmPassword) {
    return '请填写所有字段'
  }
  // 强度规则与服务端 validatePassword 一致（app/utils/password.ts 是同一套）。
  // 原来这里只查长度，于是「自己改密码」能填一个纯 8 位数字，提交后被服务端
  // 400 —— 而管理员重置密码时却被前端拦着不让填。同一个规则两种待遇。
  if (!isStrongPassword(form.newPassword)) {
    return `新密码${PASSWORD_RULE_TEXT}`
  }
  if (form.newPassword === form.currentPassword) {
    return '新密码不能与当前密码相同'
  }
  if (form.newPassword !== form.confirmPassword) {
    return '两次输入的新密码不一致'
  }
  return ''
}

const handleChangePassword = async () => {
  error.value = ''
  success.value = ''

  const msg = validate()
  if (msg) {
    error.value = msg
    return
  }

  try {
    loading.value = true

    await $fetch('/api/auth/change-password', {
      method: 'POST',
      body: {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword
      }
    })

    success.value = '密码修改成功，请重新登陆'
    form.currentPassword = ''
    form.newPassword = ''
    form.confirmPassword = ''
    await useAuth().logout()
    setTimeout(() => navigateTo("/login"), 1000)
  } catch (err: any) {
    error.value = toMessage(err, '修改失败，请重试')
  } finally {
    loading.value = false
  }
}
</script>