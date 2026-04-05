<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'

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
const MESSAGE_TIMEOUT_MS = 4000
let pollTimer: number | null = null
let noticeTimer: number | null = null
let errorTimer: number | null = null
const recordStatusMap = new Map<number, string>()

function resetMessageTimer(type: 'notice' | 'error') {
  if (type === 'notice' && noticeTimer !== null) {
    window.clearTimeout(noticeTimer)
    noticeTimer = null
  }
  if (type === 'error' && errorTimer !== null) {
    window.clearTimeout(errorTimer)
    errorTimer = null
  }
}

function scheduleMessageClear(type: 'notice' | 'error') {
  resetMessageTimer(type)
  if (type === 'notice' && notice.value) {
    noticeTimer = window.setTimeout(() => {
      notice.value = ''
      noticeTimer = null
    }, MESSAGE_TIMEOUT_MS)
  }
  if (type === 'error' && errorMessage.value) {
    errorTimer = window.setTimeout(() => {
      errorMessage.value = ''
      errorTimer = null
    }, MESSAGE_TIMEOUT_MS)
  }
}

function describeSource(record: UploadRecord) {
  return record.original_filename || `记录 ${record.id}`
}

function syncStatusNotifications(nextRecords: UploadRecord[]) {
  let nextNotice = ''
  let nextError = ''

  nextRecords.forEach((record) => {
    const previousStatus = recordStatusMap.get(record.id)
    const currentStatus = record.status
    recordStatusMap.set(record.id, currentStatus)

    if (!previousStatus || previousStatus === currentStatus) {
      return
    }

    if (currentStatus === 'completed') {
      nextNotice = `${describeSource(record)} 转写完成`
      return
    }

    if (currentStatus === 'failed') {
      nextError = record.error_message
        ? `${describeSource(record)} 转写失败：${record.error_message}`
        : `${describeSource(record)} 转写失败`
    }
  })

  if (nextNotice) {
    notice.value = nextNotice
    errorMessage.value = ''
  }
  if (nextError) {
    errorMessage.value = nextError
    notice.value = ''
  }
}

async function loadRecords() {
  if (!authStore.token) {
    return
  }
  const nextRecords = await listUploads(authStore.token, 'local')
  syncStatusNotifications(nextRecords)
  records.value = nextRecords
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
  if (record.status === 'completed') {
    notice.value = `${describeSource(record)} 转写完成`
    errorMessage.value = ''
  } else if (record.status === 'failed') {
    errorMessage.value = record.error_message
      ? `${describeSource(record)} 转写失败：${record.error_message}`
      : `${describeSource(record)} 转写失败`
    notice.value = ''
  }
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
      if (result.upload.status === 'failed') {
        errorMessage.value = result.upload.error_message || '转写失败'
        notice.value = ''
      }
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

watch(notice, () => {
  scheduleMessageClear('notice')
})

watch(errorMessage, () => {
  scheduleMessageClear('error')
})

onUnmounted(() => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  resetMessageTimer('notice')
  resetMessageTimer('error')
})
</script>

<template>
  <div class="page-grid">
    <UploadPanel @upload="handleUpload" />
    <p v-if="loading" class="notice">正在转写中，首次加载 Whisper 模型可能需要一些时间。</p>
    <Transition name="message-fade">
      <p v-if="notice" class="success-box">{{ notice }}</p>
    </Transition>
    <Transition name="message-fade">
      <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>
    </Transition>
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
