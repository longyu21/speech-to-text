<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import type { User } from '@/types'

const props = defineProps<{
  users: User[]
}>()

const emit = defineEmits<{
  create: [payload: { username: string; full_name: string; email: string; password: string; role: string; is_active: boolean; can_upload: boolean; can_manage_files: boolean; can_manage_users: boolean; can_manage_settings: boolean; can_view_audit_logs: boolean }]
  update: [userId: number, payload: { full_name: string; email: string; password?: string; role: string; is_active: boolean; can_upload: boolean; can_manage_files: boolean; can_manage_users: boolean; can_manage_settings: boolean; can_view_audit_logs: boolean }]
  remove: [userId: number]
}>()

const newUser = reactive({
  username: '',
  full_name: '',
  email: '',
  password: '',
  role: 'user',
  is_active: true,
  can_upload: true,
  can_manage_files: false,
  can_manage_users: false,
  can_manage_settings: false,
  can_view_audit_logs: false,
})

const draftPasswords = reactive<Record<number, string>>({})
const currentPage = ref(1)
const pageSize = 10

const totalPages = computed(() => Math.max(1, Math.ceil(props.users.length / pageSize)))
const paginatedUsers = computed(() => {
  const startIndex = (currentPage.value - 1) * pageSize
  return props.users.slice(startIndex, startIndex + pageSize)
})

watch(
  () => props.users.length,
  () => {
    if (currentPage.value > totalPages.value) {
      currentPage.value = totalPages.value
    }
  },
)

function submitCreate() {
  emit('create', { ...newUser })
  newUser.username = ''
  newUser.full_name = ''
  newUser.email = ''
  newUser.password = ''
  newUser.role = 'user'
  newUser.is_active = true
  newUser.can_upload = true
  newUser.can_manage_files = false
  newUser.can_manage_users = false
  newUser.can_manage_settings = false
  newUser.can_view_audit_logs = false
}

function submitUpdate(user: User) {
  emit('update', user.id, {
    full_name: user.full_name || '',
    email: user.email || '',
    password: draftPasswords[user.id] || undefined,
    role: user.role,
    is_active: user.is_active,
    can_upload: user.can_upload,
    can_manage_files: user.can_manage_files,
    can_manage_users: user.can_manage_users,
    can_manage_settings: user.can_manage_settings,
    can_view_audit_logs: user.can_view_audit_logs,
  })
  draftPasswords[user.id] = ''
}

function goToPreviousPage() {
  if (currentPage.value > 1) {
    currentPage.value -= 1
  }
}

function goToNextPage() {
  if (currentPage.value < totalPages.value) {
    currentPage.value += 1
  }
}
</script>

<template>
  <section class="panel">
    <p class="eyebrow">Admin</p>
    <h2>用户一览</h2>
    <div class="form-grid" style="margin: 18px 0 26px;">
      <div class="inline-form">
        <label>
          用户名
          <input v-model="newUser.username" />
        </label>
        <label>
          姓名
          <input v-model="newUser.full_name" />
        </label>
      </div>
      <div class="inline-form">
        <label>
          邮箱
          <input v-model="newUser.email" type="email" />
        </label>
        <label>
          密码
          <input v-model="newUser.password" type="password" />
        </label>
      </div>
      <div class="inline-form">
        <label>
          角色
          <select v-model="newUser.role">
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          状态
          <select v-model="newUser.is_active">
            <option :value="true">启用</option>
            <option :value="false">禁用</option>
          </select>
        </label>
      </div>
      <div>
        <button class="primary-button" type="button" @click="submitCreate">创建用户</button>
      </div>
      <div class="checkbox-grid">
        <label><input v-model="newUser.can_upload" type="checkbox" />允许上传</label>
        <label><input v-model="newUser.can_manage_files" type="checkbox" />文件管理</label>
        <label><input v-model="newUser.can_manage_users" type="checkbox" />用户管理</label>
        <label><input v-model="newUser.can_manage_settings" type="checkbox" />设置管理</label>
        <label><input v-model="newUser.can_view_audit_logs" type="checkbox" />查看审计</label>
      </div>
    </div>

    <div class="table-wrap" v-if="props.users.length">
    <table class="table auto-width-table">
      <thead>
        <tr>
          <th>用户名</th>
          <th>姓名</th>
          <th>邮箱</th>
          <th>角色</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in paginatedUsers" :key="user.id">
          <td>{{ user.username }}</td>
          <td><input v-model="user.full_name" /></td>
          <td><input v-model="user.email" type="email" /></td>
          <td>
            <select v-model="user.role">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </td>
          <td>
            <select v-model="user.is_active">
              <option :value="true">启用</option>
              <option :value="false">禁用</option>
            </select>
          </td>
          <td>
            <div class="form-grid">
              <input v-model="draftPasswords[user.id]" type="password" placeholder="新密码，可留空" />
              <div class="checkbox-grid compact">
                <label><input v-model="user.can_upload" type="checkbox" />上传</label>
                <label><input v-model="user.can_manage_files" type="checkbox" />文件</label>
                <label><input v-model="user.can_manage_users" type="checkbox" />用户</label>
                <label><input v-model="user.can_manage_settings" type="checkbox" />设置</label>
                <label><input v-model="user.can_view_audit_logs" type="checkbox" />审计</label>
              </div>
              <div class="table-actions">
                <button class="secondary-button" type="button" @click="submitUpdate(user)">保存</button>
                <button class="danger-button" type="button" @click="emit('remove', user.id)">删除</button>
              </div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    </div>
    <p v-else class="empty-state">暂无用户数据。</p>
    <div v-if="props.users.length" class="pagination-bar">
      <span class="muted">第 {{ currentPage }} / {{ totalPages }} 页，每页 10 条</span>
      <div class="table-actions">
        <button class="secondary-button" type="button" :disabled="currentPage === 1" @click="goToPreviousPage">
          上一页
        </button>
        <button class="secondary-button" type="button" :disabled="currentPage === totalPages" @click="goToNextPage">
          下一页
        </button>
      </div>
    </div>
  </section>
</template>
