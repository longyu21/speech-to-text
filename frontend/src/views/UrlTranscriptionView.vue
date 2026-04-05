<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { buildUploadMediaUrl, createUrlTranscription, deleteUpload, downloadTranscript, downloadTranscriptText, getTranslatedTranscript, listUploads } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { TranscriptSegment, TranscriptTranslationResult, TranslationLanguage, UploadRecord } from '@/types'

const authStore = useAuthStore()
const urlInput = ref('')
const records = ref<UploadRecord[]>([])
const selectedId = ref<number | null>(null)
const loading = ref(false)
const notice = ref('')
const errorMessage = ref('')
const translationEnabled = ref(false)
const translationLanguage = ref<TranslationLanguage>('zh')
const downloadFormat = ref<'txt' | 'docx'>('txt')
const translationLoading = ref(false)
const deletingRecordId = ref<number | null>(null)
const currentTime = ref(0)
const activeSegmentIndex = ref(-1)
const mediaElement = ref<HTMLMediaElement | null>(null)
const MESSAGE_TIMEOUT_MS = 4000
const recordStatusMap = new Map<number, string>()
const segmentElementMap = new Map<number, HTMLElement>()
const translationCache = ref<Record<number, Partial<Record<TranslationLanguage, TranscriptTranslationResult>>>>({})
let pollTimer: number | null = null
let noticeTimer: number | null = null
let errorTimer: number | null = null

const translationOptions: Array<{ value: TranslationLanguage; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日语' },
  { value: 'en', label: '英语' },
]

const downloadFormatOptions = [
  { value: 'txt', label: 'Text' },
  { value: 'docx', label: 'Word' },
] as const

const progressLabels: Record<string, string> = {
  queued: '等待处理',
  resolving_url: '解析链接',
  downloading_media: '下载媒体',
  extracting_audio: '提取音轨',
  transcribing: '正在识别语音',
  completed: '已完成',
  failed: '处理失败',
}

const urlRecords = computed(() => records.value.filter((record) => Boolean(record.source_url)))
const selectedRecord = computed(() => urlRecords.value.find((record) => record.id === selectedId.value) ?? urlRecords.value[0] ?? null)
const selectedSegments = computed(() => selectedRecord.value?.transcript_segments ?? [])
const selectedHasTranscript = computed(() => Boolean(selectedRecord.value?.transcript_text?.trim()) || selectedSegments.value.length > 0)
const selectedTranslation = computed(() => {
  const recordId = selectedRecord.value?.id
  if (!recordId || !translationEnabled.value) {
    return null
  }
  return translationCache.value[recordId]?.[translationLanguage.value] ?? null
})
const translatedSegments = computed(() => selectedTranslation.value?.segments ?? [])
const translatedTranscriptText = computed(() => selectedTranslation.value?.text ?? '')
const canTranslateSelected = computed(() => selectedRecord.value?.status === 'completed' && selectedHasTranscript.value)
const showTranslationSkeleton = computed(() => translationEnabled.value && translationLoading.value && canTranslateSelected.value)
const translationStatusMessage = computed(() => {
  if (!translationEnabled.value || !canTranslateSelected.value) {
    return ''
  }
  if (translationLoading.value) {
    return '正在生成翻译文本，请稍候。'
  }
  if (selectedTranslation.value) {
    return `当前显示 ${selectedTranslation.value.target_language_label} 翻译。`
  }
  return ''
})
const selectedPersistentError = computed(() => {
  if (!selectedRecord.value) {
    return ''
  }
  if (selectedRecord.value.status === 'failed') {
    return formatRuntimeError(selectedRecord.value.error_message)
  }
  if (selectedRecord.value.status === 'completed' && !selectedHasTranscript.value) {
    return formatRuntimeError(selectedRecord.value.error_message || '未识别到可显示的语音文本，请检查视频是否包含清晰的人声。')
  }
  return ''
})
const selectedPersistentNotice = computed(() => {
  if (!selectedRecord.value) {
    return ''
  }
  if (selectedRecord.value.status === 'queued') {
    return `任务已入队，当前阶段：${formatProgressStage(selectedRecord.value)}。`
  }
  if (selectedRecord.value.status === 'processing') {
    if (selectedSegments.value.length) {
      return `已生成前 ${selectedSegments.value.length} 段文本，可先播放媒体，剩余内容继续转写中。`
    }
    return `当前阶段：${formatProgressStage(selectedRecord.value)}，请稍候。`
  }
  if (selectedRecord.value.status === 'completed' && selectedHasTranscript.value) {
    return '转写已完成，可以播放视频并同步查看文本。'
  }
  return ''
})
const mediaUrl = computed(() => {
  if (!authStore.token || !selectedRecord.value) {
    return ''
  }
  return buildUploadMediaUrl(selectedRecord.value.id, authStore.token)
})
const isVideoSource = computed(() => selectedRecord.value?.source_type === 'video')
const canPreviewSelectedMedia = computed(() => {
  if (!selectedRecord.value || !mediaUrl.value) {
    return false
  }
  if (selectedRecord.value.source_type !== 'audio' && selectedRecord.value.source_type !== 'video') {
    return false
  }
  return ['extracting_audio', 'transcribing', 'completed', 'failed'].includes(selectedRecord.value.processing_stage || '')
})
const selectedProgressPercent = computed(() => normalizeProgressPercent(selectedRecord.value?.progress_percent ?? 0, selectedRecord.value?.status ?? 'queued'))

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

function formatRuntimeError(message: string | null | undefined) {
  const normalized = (message || '').trim()
  if (!normalized) {
    return '转写失败，请稍后重试。'
  }
  if (normalized === 'No speech could be recognized from the media') {
    return '未识别到可转写的语音内容，请确认视频里有清晰的人声。'
  }
  return normalized
}

function normalizeProgressPercent(progressPercent: number, status: string) {
  if (status === 'completed' || status === 'failed') {
    return 100
  }
  return Math.min(100, Math.max(0, Math.round(progressPercent || 0)))
}

function formatProgressStage(record: UploadRecord) {
  return progressLabels[record.processing_stage || record.status] || '处理中'
}

function syncStatusNotifications(nextRecords: UploadRecord[]) {
  let nextNotice = ''
  let nextError = ''

  nextRecords.forEach((record) => {
    const previousStatus = recordStatusMap.get(record.id)
    recordStatusMap.set(record.id, record.status)
    if (!previousStatus || previousStatus === record.status) {
      return
    }

    if (record.status === 'completed') {
      nextNotice = `${describeSource(record)} 转写完成`
      return
    }

    if (record.status === 'failed') {
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

async function ensureTranslation(record: UploadRecord) {
  if (!authStore.token || !translationEnabled.value || record.status !== 'completed') {
    return
  }
  if (translationCache.value[record.id]?.[translationLanguage.value]) {
    return
  }
  translationLoading.value = true
  try {
    const translated = await getTranslatedTranscript(record.id, translationLanguage.value, authStore.token)
    translationCache.value = {
      ...translationCache.value,
      [record.id]: {
        ...(translationCache.value[record.id] ?? {}),
        [translationLanguage.value]: translated,
      },
    }
  } finally {
    translationLoading.value = false
  }
}

async function loadRecords() {
  if (!authStore.token) {
    return
  }
  const nextRecords = await listUploads(authStore.token, 'url')
  syncStatusNotifications(nextRecords)
  records.value = nextRecords

  if (selectedId.value === null && urlRecords.value[0]) {
    selectedId.value = urlRecords.value[0].id
  }

  if (selectedId.value !== null && !urlRecords.value.some((record) => record.id === selectedId.value)) {
    selectedId.value = urlRecords.value[0]?.id ?? null
  }

  const hasPendingTasks = urlRecords.value.some((record) => record.status === 'queued' || record.status === 'processing')
  if (hasPendingTasks && pollTimer === null) {
    pollTimer = window.setInterval(() => {
      loadRecords().catch((error) => {
        errorMessage.value = error instanceof Error ? error.message : 'URL 转写状态刷新失败'
      })
    }, 800)
  }
  if (!hasPendingTasks && pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

async function handleSubmit() {
  if (!authStore.token || !urlInput.value.trim()) {
    return
  }
  loading.value = true
  notice.value = ''
  errorMessage.value = ''
  try {
    const result = await createUrlTranscription(urlInput.value.trim(), authStore.token)
    selectedId.value = result.upload.id
    notice.value = result.duplicate_detected
      ? '相同链接已有任务，已为你定位到现有记录。'
      : 'URL 媒体已解析完成，任务已入队转写。'
    urlInput.value = ''
    await loadRecords()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'URL 解析失败'
  } finally {
    loading.value = false
  }
}

async function handleDownloadTranscriptFile(uploadId: number) {
  if (!authStore.token) {
    return
  }
  errorMessage.value = ''
  try {
    const includeTranslation = translationEnabled.value
    const targetLanguage = includeTranslation ? translationLanguage.value : undefined
    const { blob, filename } = downloadFormat.value === 'docx'
      ? await downloadTranscript(uploadId, authStore.token, { includeTranslation, targetLanguage })
      : await downloadTranscriptText(uploadId, authStore.token, { includeTranslation, targetLanguage })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename || `transcript-${uploadId}.${downloadFormat.value}`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '文件下载失败'
  }
}

function handleSelect(record: UploadRecord) {
  selectedId.value = record.id
}

async function handleDelete(recordId: number) {
  if (!authStore.token || deletingRecordId.value !== null) {
    return
  }
  const targetRecord = urlRecords.value.find((record) => record.id === recordId)
  if (!targetRecord) {
    return
  }
  if (!window.confirm(`确认删除 ${describeSource(targetRecord)} 吗？`)) {
    return
  }

  deletingRecordId.value = recordId
  errorMessage.value = ''
  try {
    await deleteUpload(recordId, authStore.token)
    const nextCache = { ...translationCache.value }
    delete nextCache[recordId]
    translationCache.value = nextCache
    notice.value = `${describeSource(targetRecord)} 已删除`
    await loadRecords()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除 URL 记录失败'
  } finally {
    deletingRecordId.value = null
  }
}

function setSegmentElement(index: number, element: Element | { $el?: Element | null } | null) {
  const resolvedElement = element instanceof HTMLElement
    ? element
    : element && '$el' in element && element.$el instanceof HTMLElement
      ? element.$el
      : null
  if (resolvedElement instanceof HTMLElement) {
    segmentElementMap.set(index, resolvedElement)
    return
  }
  segmentElementMap.delete(index)
}

function resolveActiveSegmentIndex(segments: TranscriptSegment[], time: number) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (time >= segments[index].start) {
      return index
    }
  }
  return -1
}

function setMediaElementState() {
  currentTime.value = mediaElement.value?.currentTime ?? 0
  activeSegmentIndex.value = findActiveSegmentIndex(selectedSegments.value, currentTime.value)
}

function captureMediaElement(element: Element | { $el?: Element | null } | null) {
  const resolvedElement = element instanceof HTMLMediaElement
    ? element
    : element && '$el' in element && element.$el instanceof HTMLMediaElement
      ? element.$el
      : null
  mediaElement.value = resolvedElement
}

function handlePlaybackSync() {
  setMediaElementState()
}

function seekToSegment(segment: TranscriptSegment) {
  if (!mediaElement.value) {
    return
  }
  mediaElement.value.currentTime = Math.max(segment.start, 0)
  setMediaElementState()
  mediaElement.value.play().catch(() => undefined)
}

function findActiveSegmentIndex(segments: TranscriptSegment[], time: number) {
  if (!segments.length) {
    return -1
  }
  const exactIndex = segments.findIndex((segment) => time >= segment.start && time < segment.end)
  if (exactIndex >= 0) {
    return exactIndex
  }
  return resolveActiveSegmentIndex(segments, time)
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return '00:00'
  }
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

watch(notice, () => {
  scheduleMessageClear('notice')
})

watch(errorMessage, () => {
  scheduleMessageClear('error')
})

watch(selectedRecord, async (record) => {
  if (!record) {
    activeSegmentIndex.value = -1
    currentTime.value = 0
    segmentElementMap.clear()
    return
  }
  selectedId.value = record.id
  currentTime.value = 0
  activeSegmentIndex.value = -1
  if (translationEnabled.value && record.status === 'completed' && selectedHasTranscript.value) {
    try {
      await ensureTranslation(record)
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '翻译加载失败'
    }
  }
  await nextTick()
  setMediaElementState()
})

watch([translationEnabled, translationLanguage], async ([enabled]) => {
  if (!enabled || !selectedRecord.value || !canTranslateSelected.value) {
    return
  }
  try {
    await ensureTranslation(selectedRecord.value)
    await nextTick()
    setMediaElementState()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '翻译加载失败'
  }
})

watch(activeSegmentIndex, async (index) => {
  if (index < 0) {
    return
  }
  await nextTick()
  segmentElementMap.get(index)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
})

onMounted(() => {
  loadRecords().catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '加载 URL 记录失败'
  })
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
  <div class="url-page-grid">
    <section class="panel url-intake-panel">
      <p class="eyebrow">URL Transcript</p>
      <h2>视频 URL 解析转写</h2>
      <p class="helper-text">输入视频或音频地址，系统会先解析媒体，再提取语音并转成文本。完成后可直接在页面播放并同步查看高亮文本。</p>
      <div class="url-intake-row">
        <input v-model="urlInput" type="url" placeholder="https://example.com/video" @keydown.enter.prevent="handleSubmit">
        <button class="primary-button" type="button" :disabled="loading || !urlInput.trim()" @click="handleSubmit">
          {{ loading ? '解析中...' : '开始解析' }}
        </button>
      </div>
      <Transition name="message-fade">
        <p v-if="notice" class="success-box">{{ notice }}</p>
      </Transition>
      <Transition name="message-fade">
        <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>
      </Transition>
    </section>

    <div class="url-workspace-grid">
      <section class="panel player-panel">
        <div class="player-header">
          <div>
            <p class="eyebrow">Media</p>
            <h2>{{ selectedRecord?.original_filename || '未选择媒体' }}</h2>
          </div>
          <div class="tag-list">
            <span class="status-badge">状态: {{ selectedRecord?.status || 'idle' }}</span>
            <span class="status-badge">语言: {{ selectedRecord?.detected_language || '待识别' }}</span>
          </div>
        </div>

        <a v-if="selectedRecord?.source_url" class="source-link" :href="selectedRecord.source_url" target="_blank" rel="noreferrer">原始链接</a>

        <video
          v-if="selectedRecord && canPreviewSelectedMedia && isVideoSource && mediaUrl"
          :key="selectedRecord.id"
          :ref="captureMediaElement"
          class="media-player"
          controls
          playsinline
          :src="mediaUrl"
          @timeupdate="handlePlaybackSync"
          @loadedmetadata="handlePlaybackSync"
          @seeked="handlePlaybackSync"
        />
        <audio
          v-else-if="selectedRecord && canPreviewSelectedMedia && mediaUrl"
          :key="selectedRecord.id"
          :ref="captureMediaElement"
          class="audio-player"
          controls
          :src="mediaUrl"
          @timeupdate="handlePlaybackSync"
          @loadedmetadata="handlePlaybackSync"
          @seeked="handlePlaybackSync"
        />
        <p v-else class="empty-state">选择一条 URL 转写记录后，可在这里直接播放媒体。</p>

        <div class="toolbar" style="margin-top: 18px;">
          <span class="status-badge">当前播放: {{ formatTime(currentTime) }}</span>
          <span v-if="selectedRecord" class="status-badge">{{ formatProgressStage(selectedRecord) }} {{ selectedProgressPercent }}%</span>
          <label class="toggle-row" for="translation-toggle">
            <input id="translation-toggle" v-model="translationEnabled" type="checkbox" :disabled="!canTranslateSelected || translationLoading">
            <span>翻译文本</span>
          </label>
          <select v-model="translationLanguage" :disabled="!translationEnabled || !canTranslateSelected || translationLoading" style="max-width: 160px;">
            <option v-for="option in translationOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <select v-model="downloadFormat" style="max-width: 160px;">
            <option v-for="option in downloadFormatOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <span v-if="showTranslationSkeleton" class="status-badge status-badge--loading">翻译加载中...</span>
          <button
            v-if="selectedRecord"
            class="secondary-button"
            type="button"
            :disabled="!selectedRecord.transcript_text"
            @click="handleDownloadTranscriptFile(selectedRecord.id)"
          >
            下载{{ downloadFormat === 'docx' ? 'Word' : 'Text' }}
          </button>
        </div>
      </section>

      <section class="panel sync-panel">
        <p class="eyebrow">Transcript</p>
        <h2>同步文本</h2>
        <p v-if="selectedPersistentNotice" class="notice">{{ selectedPersistentNotice }}</p>
        <p v-if="translationStatusMessage" class="notice">{{ translationStatusMessage }}</p>
        <p v-if="selectedPersistentError" class="error-box">{{ selectedPersistentError }}</p>
        <div v-if="selectedRecord" class="progress-panel" :aria-label="`当前任务进度 ${selectedProgressPercent}%`">
          <div class="progress-track">
            <span class="progress-fill" :style="{ width: `${selectedProgressPercent}%` }"></span>
          </div>
          <div class="progress-meta">
            <span>{{ formatProgressStage(selectedRecord) }}</span>
            <span>{{ selectedProgressPercent }}%</span>
          </div>
        </div>
        <div v-if="selectedSegments.length" class="segment-list">
          <button
            v-for="(segment, index) in selectedSegments"
            :key="`${selectedRecord?.id}-${index}`"
            :ref="(element) => setSegmentElement(index, element)"
            class="segment-card"
            :class="{ active: index === activeSegmentIndex }"
            type="button"
            @click="seekToSegment(segment)"
          >
            <span class="segment-time">{{ formatTime(segment.start) }} - {{ formatTime(segment.end) }}</span>
            <span class="segment-text">{{ segment.text }}</span>
            <span v-if="translationEnabled && translatedSegments[index]?.text && translatedSegments[index].text !== segment.text" class="segment-text-secondary">{{ translatedSegments[index].text }}</span>
            <span v-else-if="showTranslationSkeleton" class="segment-text-skeleton"></span>
          </button>
        </div>
        <div v-else-if="selectedRecord?.transcript_text" class="plain-transcript-stack">
          <div class="plain-transcript-box">
            {{ selectedRecord.transcript_text }}
          </div>
          <div v-if="translationEnabled && translatedTranscriptText && translatedTranscriptText !== selectedRecord.transcript_text" class="plain-transcript-box plain-transcript-box--secondary">
            {{ translatedTranscriptText }}
          </div>
          <div v-else-if="showTranslationSkeleton" class="plain-transcript-box plain-transcript-box--secondary plain-transcript-box--skeleton">
            <span class="transcript-skeleton-line"></span>
            <span class="transcript-skeleton-line"></span>
            <span class="transcript-skeleton-line transcript-skeleton-line--short"></span>
          </div>
        </div>
        <p v-else class="empty-state">转写完成后，带时间轴的文本会显示在这里；如果失败，会在这里显示具体报错。</p>
      </section>
    </div>

    <section class="panel">
      <p class="eyebrow">History</p>
      <h2>最近 URL 任务</h2>
      <div class="table-wrap">
        <table class="record-list" v-if="urlRecords.length">
          <thead>
            <tr>
              <th>媒体</th>
              <th>来源</th>
              <th>状态</th>
              <th>文本</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in urlRecords" :key="record.id" :class="{ 'selected-row': record.id === selectedRecord?.id }">
              <td>
                <strong>{{ record.original_filename }}</strong>
                <div class="muted">{{ record.detected_language || '待识别' }}</div>
              </td>
              <td>
                <div>{{ record.source_type === 'video' ? '视频 URL' : '音频 URL' }}</div>
                <div class="muted clamp-text">{{ record.source_url }}</div>
              </td>
              <td>
                <div>{{ record.status }}</div>
                <div class="progress-panel progress-panel--compact">
                  <div class="progress-track">
                    <span class="progress-fill" :style="{ width: `${normalizeProgressPercent(record.progress_percent, record.status)}%` }"></span>
                  </div>
                  <div class="muted">{{ formatProgressStage(record) }} {{ normalizeProgressPercent(record.progress_percent, record.status) }}%</div>
                </div>
                <div class="muted" v-if="record.error_message">{{ record.error_message }}</div>
              </td>
              <td>
                <div class="table-actions">
                  <button class="secondary-button" type="button" @click="handleSelect(record)">查看</button>
                  <button class="ghost-button" type="button" :disabled="!record.transcript_text" @click="handleDownloadTranscriptFile(record.id)">下载{{ downloadFormat === 'docx' ? 'Word' : 'Text' }}</button>
                  <button class="ghost-button danger-button" type="button" :disabled="deletingRecordId === record.id" @click="handleDelete(record.id)">
                    {{ deletingRecordId === record.id ? '删除中...' : '删除' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty-state">当前还没有 URL 解析记录。</p>
      </div>
    </section>
  </div>
</template>