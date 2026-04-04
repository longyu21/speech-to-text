<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { register as registerRequest } from '@/api/client'

const router = useRouter()
const username = ref('')
const fullName = ref('')
const email = ref('')
const password = ref('')
const notice = ref('')
const errorMessage = ref('')
const loading = ref(false)
const showPassword = ref(false)

async function handleRegister() {
  loading.value = true
  notice.value = ''
  errorMessage.value = ''
  try {
    const response = await registerRequest({
      username: username.value,
      full_name: fullName.value,
      email: email.value || null,
      password: password.value,
    })
    notice.value = `${response.message}，现在可以使用你的账号登录。`
    setTimeout(() => {
      router.push({ name: 'login' })
    }, 1800)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '注册失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <section class="login-card">
      <p class="eyebrow">Register</p>
      <h2>创建账户</h2>
      <div class="form-grid" style="margin-top: 20px;">
        <label>
          用户名
          <input v-model="username" autocomplete="username" />
        </label>
        <label>
          姓名
          <input v-model="fullName" />
        </label>
        <label>
          邮箱
          <input v-model="email" type="email" autocomplete="email" />
        </label>
        <label>
          密码
          <input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" @keyup.enter="handleRegister" />
        </label>
        <label class="toggle-row"><input v-model="showPassword" type="checkbox" />显示密码</label>
        <button class="primary-button" type="button" :disabled="loading" @click="handleRegister">
          {{ loading ? '注册中...' : '注册' }}
        </button>
        <RouterLink class="ghost-button" to="/login">返回登录</RouterLink>
        <p v-if="notice" class="success-box">{{ notice }}</p>
        <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>
      </div>
    </section>
  </div>
</template>
