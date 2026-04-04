<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { createSpeechGeneration, deleteSpeechGeneration, downloadSpeechAudio, fetchSpeechAudio, listSpeechGenerations } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { SpeechGenerationCreateResponse, SpeechGenerationRecord } from '@/types'
import { formatBackendDateTime } from '@/utils/datetime'

const authStore = useAuthStore()
const textInput = ref('')
const selectedStyle = ref('normal')
const selectedOutputFormat = ref('mp3')
const selectedDocument = ref<File | null>(null)
const records = ref<SpeechGenerationRecord[]>([])
const selectedRecord = ref<SpeechGenerationRecord | null>(null)
const audioUrl = ref('')
const languageLabel = ref('待识别')
const notice = ref('')
const errorMessage = ref('')
const loading = ref(false)

const styleOptions = [
  { value: 'normal', label: '正常会话风格' },
  { value: 'male', label: '男声' },
  { value: 'female', label: '女声' },
  { value: 'cute', label: '可爱风格' },
  { value: 'anime', label: '动漫风格' },
  { value: 'news', label: '新闻风格' },
  { value: 'chat', label: '轻松对话风格' },
]

const outputFormatOptions = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV' },
  { value: 'm4a', label: 'M4A' },
]

async function loadRecords() {
  if (!authStore.token) {
    return
  }
  records.value = await listSpeechGenerations(authStore.token)
  if (!selectedRecord.value && records.value.length) {
    await selectRecord(records.value[0])
  }
}

function handleDocumentChange(event: Event) {
  const target = event.target as HTMLInputElement
  selectedDocument.value = target.files?.[0] ?? null
}

async function handleGenerate() {
  if (!authStore.token) {
    return
  }
  if (!textInput.value.trim() && !selectedDocument.value) {
    errorMessage.value = '请输入文本或者上传文档'
    return
  }
  loading.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    const response: SpeechGenerationCreateResponse = await createSpeechGeneration(
      {
        text: textInput.value.trim(),
        style: selectedStyle.value,
        outputFormat: selectedOutputFormat.value,
        document: selectedDocument.value,
      },
      authStore.token,
    )
    notice.value = `语音生成完成，识别语言为 ${response.language_label}`
    languageLabel.value = response.language_label
    await loadRecords()
    const latestRecord = records.value.find((record) => record.id === response.record.id) || response.record
    await selectRecord(latestRecord)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '语音生成失败'
  } finally {
    loading.value = false
  }
}

async function selectRecord(record: SpeechGenerationRecord) {
  selectedRecord.value = record
  languageLabel.value = record.detected_language
  if (!authStore.token) {
    return
  }
  if (audioUrl.value) {
    URL.revokeObjectURL(audioUrl.value)
  }
  const blob = await fetchSpeechAudio(record.id, authStore.token)
  audioUrl.value = URL.createObjectURL(blob)
}

async function handleDownload(recordId: number) {
  const record = records.value.find((item) => item.id === recordId)
  if (!authStore.token) {
    return
  }
  try {
    const { blob, filename } = await downloadSpeechAudio(recordId, authStore.token)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename || record?.stored_filename || `speech-${recordId}.wav`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '下载失败'
  }
}

async function handleDelete(recordId: number) {
  if (!authStore.token) {
    return
  }
  const confirmed = window.confirm('确认删除这条已生成语音记录吗？')
  if (!confirmed) {
    return
  }
  errorMessage.value = ''
  notice.value = ''
  try {
    await deleteSpeechGeneration(recordId, authStore.token)
    if (selectedRecord.value?.id === recordId) {
      selectedRecord.value = null
      languageLabel.value = '待识别'
      if (audioUrl.value) {
        URL.revokeObjectURL(audioUrl.value)
        audioUrl.value = ''
      }
    }
    await loadRecords()
    if (!selectedRecord.value && records.value.length) {
      await selectRecord(records.value[0])
    }
    notice.value = '语音记录已删除'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除失败'
  }
}

onMounted(() => {
  loadRecords().catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '加载语音生成记录失败'
  })
})

onUnmounted(() => {
  if (audioUrl.value) {
    URL.revokeObjectURL(audioUrl.value)
  }
})
</script>

<template>
  <div class="page-grid">
    <section class="panel">
      <p class="eyebrow">Speech</p>
      <h2>文本生成语音</h2>
      <p class="helper-text">支持直接输入文本或上传文档，系统会自动识别中文、日语、英文并生成语音文件。</p>
      <div class="form-grid" style="margin-top: 18px;">
        <label>
          输入文本
          <textarea v-model="textInput" placeholder="请输入要转换为语音的文本"></textarea>
        </label>
        <label>
          上传文档（txt、md、docx）
          <input type="file" accept=".txt,.md,.docx" @change="handleDocumentChange" />
        </label>
        <div class="style-grid">
          <label>
            语音风格
            <select v-model="selectedStyle">
              <option v-for="style in styleOptions" :key="style.value" :value="style.value">{{ style.label }}</option>
            </select>
          </label>
          <label>
            输出格式
            <select v-model="selectedOutputFormat">
              <option v-for="format in outputFormatOptions" :key="format.value" :value="format.value">{{ format.label }}</option>
            </select>
          </label>
        </div>
        <div class="toolbar">
          <button class="primary-button" type="button" :disabled="loading" @click="handleGenerate">
            {{ loading ? '生成中...' : '生成语音' }}
          </button>
          <span class="status-badge" v-if="selectedDocument">{{ selectedDocument.name }}</span>
          <span class="status-badge">识别语言: {{ languageLabel }}</span>
        </div>
      </div>
    </section>

    <p v-if="notice" class="success-box">{{ notice }}</p>
    <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>

    <section class="panel history-card">
      <div>
        <p class="eyebrow">Preview</p>
        <h2>生成结果</h2>
        <p class="helper-text" v-if="selectedRecord">已选风格：{{ selectedRecord.style }}，音色：{{ selectedRecord.voice_name }}</p>
        <audio v-if="audioUrl" class="audio-player" :src="audioUrl" controls></audio>
        <p v-else class="empty-state">生成完成后可以直接在线试听。</p>
        <div class="toolbar" v-if="selectedRecord">
          <button class="primary-button" type="button" @click="handleDownload(selectedRecord.id)">下载音频</button>
          <button class="ghost-button" type="button" @click="handleDelete(selectedRecord.id)">删除记录</button>
        </div>
        <textarea v-if="selectedRecord" :value="selectedRecord.input_text" readonly></textarea>
      </div>

      <div>
        <h3>历史记录</h3>
        <div class="table-wrap" v-if="records.length">
          <table class="table auto-width-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>语言</th>
                <th>风格</th>
                <th>音色</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in records" :key="record.id">
                <td>{{ formatBackendDateTime(record.created_at) }}</td>
                <td>{{ record.original_filename || '文本输入' }}</td>
                <td>{{ record.detected_language }}</td>
                <td>{{ record.style }}</td>
                <td>{{ record.voice_name }}</td>
                <td>
                  <div class="table-actions">
                    <button class="secondary-button" type="button" @click="selectRecord(record)">试听</button>
                    <button class="ghost-button" type="button" @click="handleDownload(record.id)">下载</button>
                    <button class="ghost-button" type="button" @click="handleDelete(record.id)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="empty-state">当前还没有文本转语音记录。</p>
      </div>
    </section>
  </div>
</template>
