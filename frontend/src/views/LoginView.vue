<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const router = useRouter()
const username = ref('admin')
const password = ref('admin123456')
const errorMessage = ref('')
const showPassword = ref(false)

async function handleSubmit() {
  errorMessage.value = ''
  try {
    await authStore.login(username.value, password.value)
    router.push({ name: 'home' })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败'
  }
}
</script>

<template>
  <div class="login-wrap">
    <section class="login-card">
      <p class="eyebrow">Access</p>
      <h2>登录系统</h2>
      <p class="helper-text">默认管理员账号来自后端环境变量，可在首次启动后修改。</p>
      <div class="form-grid" style="margin-top: 20px;">
        <label>
          用户名
          <input v-model="username" autocomplete="username" />
        </label>
        <label>
          密码
          <input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" @keyup.enter="handleSubmit" />
        </label>
        <label class="toggle-row"><input v-model="showPassword" type="checkbox" />显示密码</label>
        <button class="primary-button" type="button" :disabled="authStore.loading" @click="handleSubmit">
          {{ authStore.loading ? '登录中...' : '登录' }}
        </button>
        <RouterLink class="ghost-button" to="/register">注册新账户</RouterLink>
        <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>
      </div>
    </section>
  </div>
</template>
