<script setup lang="ts">
import type { AuditLog } from '@/types'
import { formatBackendDateTime } from '@/utils/datetime'

const props = defineProps<{
  logs: AuditLog[]
}>()
</script>

<template>
  <section class="panel">
    <p class="eyebrow">Audit</p>
    <h2>审计日志</h2>
    <table v-if="props.logs.length" class="table" style="margin-top: 18px;">
      <thead>
        <tr>
          <th>时间</th>
          <th>动作</th>
          <th>资源</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="log in props.logs" :key="log.id">
          <td>{{ formatBackendDateTime(log.created_at) }}</td>
          <td>{{ log.action }}</td>
          <td>{{ log.resource_type }} #{{ log.resource_id ?? '-' }}</td>
          <td>{{ log.details || '-' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state" style="margin-top: 18px;">当前没有审计日志。</p>
  </section>
</template>
