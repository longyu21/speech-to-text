<script setup lang="ts">
import type { UploadRecord } from '@/types'

const props = defineProps<{
  languageLabel: string
  transcriptText: string
  records: UploadRecord[]
}>()

const emit = defineEmits<{
  download: [uploadId: number]
  select: [record: UploadRecord]
  retry: [uploadId: number]
  remove: [uploadId: number]
}>()

function formatFileSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatSourceType(sourceType: string) {
  if (sourceType === 'subtitle') {
    return '字幕导入'
  }
  if (sourceType === 'video') {
    return '视频转写'
  }
  return '音频转写'
}
</script>

<template>
  <section class="panel">
    <p class="eyebrow">Result</p>
    <h2>生成文本</h2>
    <div class="toolbar" style="margin: 14px 0 18px;">
      <span class="status-badge">识别语言: {{ props.languageLabel || '待识别' }}</span>
    </div>
    <textarea :value="props.transcriptText" readonly placeholder="转写结果将显示在这里"></textarea>
    <p v-if="!props.transcriptText" class="empty-state">上传完成后，文本会自动出现在此区域。</p>

    <div style="margin-top: 24px;">
      <h3>历史记录</h3>
      <table class="record-list" v-if="props.records.length">
        <thead>
          <tr>
            <th>文件</th>
            <th>来源</th>
            <th>语言</th>
            <th>大小</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in props.records" :key="record.id">
            <td>{{ record.original_filename }}</td>
            <td>{{ formatSourceType(record.source_type) }}</td>
            <td>{{ record.detected_language || '-' }}</td>
            <td>{{ formatFileSize(record.file_size) }}</td>
            <td>
              <div>{{ record.status }}</div>
              <div class="muted">批次: {{ record.batch_id || '-' }}</div>
              <div class="muted" v-if="record.error_message">{{ record.error_message }}</div>
            </td>
            <td>
              <div class="table-actions">
                <button class="secondary-button" type="button" @click="emit('select', record)">查看</button>
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="!record.transcript_text"
                  @click="emit('download', record.id)"
                >
                  下载 Word
                </button>
                <button class="ghost-button" type="button" @click="emit('retry', record.id)">重试</button>
                <button class="danger-button" type="button" @click="emit('remove', record.id)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">当前还没有上传记录。</p>
    </div>
  </section>
</template>
