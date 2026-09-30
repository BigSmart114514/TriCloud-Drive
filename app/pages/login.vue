<template>
  <div class="login-container">
    <!-- 浮动背景元素 -->
    <div class="background">
      <div class="float-circle circle1"></div>
      <div class="float-circle circle2"></div>
      <div class="float-circle circle3"></div>
      <div class="float-circle circle4"></div>
    </div>
    
    <div data-liquid class="login-card">
      <!-- 左侧装饰 -->
      <div class="decoration">
        <div class="logo-container">
          <div class="logo-circle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
          </div>
        </div>
        <h1 class="welcome">欢迎回来</h1>
        <p class="subtitle">请登录您的账号继续访问</p>
        <div class="waves">
          <div class="wave wave1"></div>
          <div class="wave wave2"></div>
          <div class="wave wave3"></div>
        </div>
      </div>
      
      <!-- 右侧登录表单 -->
      <div class="form-section">
        <h2 class="form-title">账户登录</h2>
        <div class="message-box" :class="messageClass" v-if="showMessage" @click="showMessage = false">
          <span>{{ messageText }}</span>
        </div>
        <form @submit.prevent="handleLogin"> 
            <div class="form-group" :class="{ 'focused': usernameFocused || username !== '' }">
                <label for="username">用户名</label>
                <input 
                type="text" 
                id="username" 
                v-model="username"
                @focus="usernameFocused = true"
                @blur="usernameFocused = false"
                >
            </div>
            
            <div class="form-group" :class="{ 'focused': passwordFocused || password !== '' }">
                <label for="password">密码</label>
                <input 
                type="password" 
                id="password" 
                v-model="password"
                @focus="passwordFocused = true"
                @blur="passwordFocused = false"
                >
            </div>
          <button class="login-btn" :disabled="loading">
            <span v-if="!loading">登录</span>
            <div v-else class="spinner">
              <div class="bounce1"></div>
              <div class="bounce2"></div>
              <div class="bounce3"></div>
            </div>
          </button>
        </form>
        <div class="footer-links">
          <a href="#">忘记密码?</a>
          <NuxtLink to="/register">注册新账号</NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">

import { NuxtLink } from '#components'
import { ref } from 'vue'
import { useRouter } from 'vue-router'

useHead({ title: '登录' })
const router = useRouter()

// 1. 在 <script setup> 顶层安全调用
const { login, isLoggedIn } = useAuth()

// 2. 如果已经登录，直接跳转
if (isLoggedIn.value) {
  // 注意：<script setup> 里要用 await 或者 .then
  await router.replace('/')
}

// 3. 登录表单的响应式状态
const username = ref('')
const password = ref('')
const loading = ref(false)
const showMessage = ref(false)
const messageText = ref('')
const messageClass = ref('')
const usernameFocused = ref(false)
const passwordFocused = ref(false)



async function handleLogin() {
  if (!username.value) {
    return showNotification('请输入用户名', 'error')
  }
  if (!password.value) {
    return showNotification('请输入密码', 'error')
  }
  loading.value = true
  try {
    const result = await login(username.value,password.value)
    
    if (result.success) {
      showNotification('登录成功，正在跳转...', 'success')
      setTimeout(() => router.push('/'), 1000)
    } else {
      showNotification('登录失败!', 'error')
    }
  } catch (e : any) {
    console.error(e)
    showNotification('登录失败，' + e.data?.statusMessage || '请重试', 'error')
  } finally {
    loading.value = false
  }
}

function showNotification(text: string, type: string) {
  messageText.value = text
  messageClass.value = type
  showMessage.value = true
  setTimeout(() => (showMessage.value = false), type === 'error' ? 3000 : 5000)
}
</script>

<style scoped src="~/assets/css/login.css"></style>

<style scoped>
/* 移动端隐藏左侧装饰，右侧表单占满宽度 */
@media (max-width: 768px) {
  .decoration {
    display: none;
  }
  .login-card {
    /* 若外层是 grid 或 flex，都能优雅降级为单列 */
    grid-template-columns: 1fr;
    flex-direction: column;
  }
  .form-section {
    width: 100%;
  }
}
</style>