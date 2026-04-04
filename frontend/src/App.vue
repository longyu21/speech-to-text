<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const router = useRouter()

const displayName = computed(() => authStore.user?.full_name || authStore.user?.username || 'Guest')

function handleLogout() {
  authStore.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div>
        <p class="eyebrow">Multilingual Speech Intelligence</p>
        <h1>语音文本转换系统</h1>
      </div>
      <nav v-if="authStore.isAuthenticated" class="main-nav">
        <RouterLink to="/">语音转文本</RouterLink>
        <RouterLink to="/speech-generation">文本转语音</RouterLink>
        <RouterLink v-if="authStore.canAccessAdmin" to="/admin">管理区域</RouterLink>
        <span class="user-chip">{{ displayName }}</span>
        <button class="ghost-button" type="button" @click="handleLogout">退出</button>
      </nav>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>
