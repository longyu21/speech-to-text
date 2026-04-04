<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  createUser,
  deleteUser,
  getSpeechLanguageSettings,
  listAuditLogs,
  listUsers,
  updateSpeechLanguageSettings,
  updateUser,
} from '@/api/client'
import AdminAuditLogsPanel from '@/components/AdminAuditLogsPanel.vue'
import AdminSettingsPanel from '@/components/AdminSettingsPanel.vue'
import AdminUsersPanel from '@/components/AdminUsersPanel.vue'
import { useAuthStore } from '@/stores/auth'
import type { AuditLog, SpeechLanguageSettings, User } from '@/types'

const authStore = useAuthStore()
const users = ref<User[]>([])
const setting = ref<SpeechLanguageSettings | null>(null)
const auditLogs = ref<AuditLog[]>([])
const notice = ref('')
const errorMessage = ref('')

async function loadAdminData() {
  if (!authStore.token) {
    return
  }
  const tasks: Promise<unknown>[] = []
  if (authStore.user?.can_manage_users) {
    tasks.push(listUsers(authStore.token).then((response) => {
      users.value = response
    }))
  }
  if (authStore.user?.can_manage_settings) {
    tasks.push(getSpeechLanguageSettings(authStore.token).then((response) => {
      setting.value = response
    }))
  }
  if (authStore.user?.can_view_audit_logs) {
    tasks.push(listAuditLogs(authStore.token).then((response) => {
      auditLogs.value = response
    }))
  }
  await Promise.all(tasks)
}

async function handleCreate(payload: { username: string; full_name: string; email: string; password: string; role: string; is_active: boolean; can_upload: boolean; can_manage_files: boolean; can_manage_users: boolean; can_manage_settings: boolean; can_view_audit_logs: boolean }) {
  if (!authStore.token) {
    return
  }
  await createUser(payload, authStore.token)
  notice.value = '用户已创建'
  await loadAdminData()
}

async function handleUpdate(userId: number, payload: { full_name: string; email: string; password?: string; role: string; is_active: boolean; can_upload: boolean; can_manage_files: boolean; can_manage_users: boolean; can_manage_settings: boolean; can_view_audit_logs: boolean }) {
  if (!authStore.token) {
    return
  }
  await updateUser(userId, payload, authStore.token)
  notice.value = '用户信息已更新'
  await loadAdminData()
}

async function handleRemove(userId: number) {
  if (!authStore.token) {
    return
  }
  await deleteUser(userId, authStore.token)
  notice.value = '用户已删除'
  await loadAdminData()
}

async function handleSaveSetting(payload: SpeechLanguageSettings) {
  if (!authStore.token) {
    return
  }
  setting.value = await updateSpeechLanguageSettings(payload, authStore.token)
  notice.value = '语音与转写词典设置已保存'
}

onMounted(() => {
  loadAdminData().catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '加载管理数据失败'
  })
})
</script>

<template>
  <div class="admin-stack">
    <section class="panel">
      <p class="eyebrow">Summary</p>
      <h2>系统提示</h2>
      <p class="success-box" v-if="notice">{{ notice }}</p>
      <p class="error-box" v-if="errorMessage">{{ errorMessage }}</p>
      <p class="helper-text" v-if="!notice && !errorMessage">
        在这里可以管理用户账户、上传大小，以及日文 TTS 读音词典和日语转写纠错词典。保存后会即时作用于后端。
      </p>
    </section>

    <AdminUsersPanel
      v-if="authStore.user?.can_manage_users"
      :users="users"
      @create="handleCreate"
      @update="handleUpdate"
      @remove="handleRemove"
    />

    <AdminSettingsPanel v-if="authStore.user?.can_manage_settings" :setting="setting" @save="handleSaveSetting" />
    <AdminAuditLogsPanel v-if="authStore.user?.can_view_audit_logs" :logs="auditLogs" />
  </div>
</template>
