<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { batchUploadAudio, deleteUpload, downloadTranscript, listUploads, retryUpload, uploadAudio } from '@/api/client'
import TranscriptPanel from '@/components/TranscriptPanel.vue'
import UploadPanel from '@/components/UploadPanel.vue'
import { useAuthStore } from '@/stores/auth'
import type { BatchTranscriptionAccepted, TranscriptionResult, UploadRecord } from '@/types'

const authStore = useAuthStore()
const records = ref<UploadRecord[]>([])
const transcriptText = ref('')
const languageLabel = ref('待识别')
const notice = ref('')
const errorMessage = ref('')
const loading = ref(false)
let pollTimer: number | null = null

async function loadRecords() {
  if (!authStore.token) {
    return
  }
  records.value = await listUploads(authStore.token)
  const latest = records.value[0]
  if (latest?.transcript_text) {
    transcriptText.value = latest.transcript_text
    languageLabel.value = latest.detected_language || 'Unknown'
  }

  const hasPendingTasks = records.value.some((record) => record.status === 'queued' || record.status === 'processing')
  if (hasPendingTasks && pollTimer === null) {
    pollTimer = window.setInterval(() => {
      loadRecords().catch(() => undefined)
    }, 3000)
  }
  if (!hasPendingTasks && pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function selectRecord(record: UploadRecord) {
  transcriptText.value = record.transcript_text || ''
  languageLabel.value = record.detected_language || 'Unknown'
}

async function handleUpload(files: File[]) {
  if (!authStore.token) {
    return
  }
  notice.value = ''
  errorMessage.value = ''
  loading.value = true
  try {
    if (files.length === 1) {
      const result: TranscriptionResult = await uploadAudio(files[0], authStore.token)
      transcriptText.value = result.text
      languageLabel.value = result.language_label
      notice.value = result.upload.status === 'completed'
        ? '文件已导入，文本已生成'
        : '文件已入队，系统将自动开始转写'
    } else {
      const result: BatchTranscriptionAccepted = await batchUploadAudio(files, authStore.token)
      notice.value = `批量任务已入队，共 ${result.uploads.length} 个文件，批次号 ${result.batch_id}`
    }
    await loadRecords()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '上传失败'
  } finally {
    loading.value = false
  }
}

async function handleDownload(uploadId: number) {
  if (!authStore.token) {
    return
  }
  errorMessage.value = ''
  try {
    const { blob, filename } = await downloadTranscript(uploadId, authStore.token)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename || `transcript-${uploadId}.docx`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '下载失败'
  }
}

async function handleRetry(uploadId: number) {
  if (!authStore.token) {
    return
  }
  try {
    await retryUpload(uploadId, authStore.token)
    notice.value = '任务已重新入队'
    await loadRecords()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '重试失败'
  }
}

async function handleRemove(uploadId: number) {
  if (!authStore.token) {
    return
  }
  try {
    await deleteUpload(uploadId, authStore.token)
    notice.value = '文件记录已删除'
    await loadRecords()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除失败'
  }
}

onMounted(() => {
  loadRecords().catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '加载失败'
  })
})

onUnmounted(() => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div class="page-grid">
    <UploadPanel @upload="handleUpload" />
    <p v-if="loading" class="notice">正在转写中，首次加载 Whisper 模型可能需要一些时间。</p>
    <p v-if="notice" class="success-box">{{ notice }}</p>
    <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>
    <TranscriptPanel
      :language-label="languageLabel"
      :records="records"
      :transcript-text="transcriptText"
      @download="handleDownload"
      @retry="handleRetry"
      @remove="handleRemove"
      @select="selectRecord"
    />
  </div>
</template>
