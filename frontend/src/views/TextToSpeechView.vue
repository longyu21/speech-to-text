<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { createSpeechGeneration, deleteSpeechGeneration, downloadSpeechAudio, fetchSpeechAudio, getSpeechGenerationOptions, listSpeechGenerations, updateSpeechFavoriteVoices } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { SpeechGenerationCreateResponse, SpeechGenerationOptions, SpeechGenerationRecord, SpeechVoiceOption } from '@/types'
import { formatBackendDateTime } from '@/utils/datetime'

const FAVORITE_VOICE_STORAGE_KEY = 'speech.favoriteVoices'
const RECENT_VOICE_STORAGE_KEY = 'speech.recentVoices'
const MAX_RECENT_VOICES = 6

const authStore = useAuthStore()
const textInput = ref('')
const selectedStyle = ref('normal')
const selectedOutputFormat = ref('mp3')
const selectedVoiceId = ref('')
const selectedSpeedRate = ref(0)
const selectedVoiceLanguage = ref('all')
const selectedVoiceSource = ref('all')
const voiceSearchKeyword = ref('')
const favoritesOnly = ref(false)
const selectedDocument = ref<File | null>(null)
const records = ref<SpeechGenerationRecord[]>([])
const selectedRecord = ref<SpeechGenerationRecord | null>(null)
const audioUrl = ref('')
const languageLabel = ref('待识别')
const voiceOptions = ref<SpeechGenerationOptions['voices']>([])
const speedOptions = ref<SpeechGenerationOptions['speeds']>([])
const favoriteVoiceIds = ref<string[]>([])
const recentVoiceIds = ref<string[]>([])
const pendingLegacyFavoriteVoiceIds = ref<string[]>([])
const notice = ref('')
const errorMessage = ref('')
const loading = ref(false)
const MESSAGE_TIMEOUT_MS = 4000
const favoriteSaving = ref(false)
const dragSection = ref<'favorite' | 'recent' | null>(null)
const dragVoiceId = ref<string | null>(null)
let noticeTimer: number | null = null
let errorTimer: number | null = null

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

const voiceLanguageOptions = computed(() => {
  const languages = new Map<string, string>()
  voiceOptions.value.forEach((voice) => {
    if (voice.locale.startsWith('ja')) {
      languages.set('ja', '日语')
      return
    }
    if (voice.locale.startsWith('zh')) {
      languages.set('zh', '中文')
      return
    }
    if (voice.locale.startsWith('en')) {
      languages.set('en', '英语')
      return
    }
    if (voice.locale) {
      languages.set(voice.locale, voice.locale)
    }
  })
  return [{ value: 'all', label: '全部语言' }, ...Array.from(languages.entries()).map(([value, label]) => ({ value, label }))]
})

const voiceSourceOptions = computed(() => [
  { value: 'all', label: '全部来源' },
  { value: 'system', label: '系统内置' },
  { value: 'edge', label: '联网音色' },
])

const filteredVoiceOptions = computed(() => {
  const keyword = voiceSearchKeyword.value.trim().toLowerCase()

  return voiceOptions.value.filter((voice) => {
    const languageMatched = selectedVoiceLanguage.value === 'all'
      || (selectedVoiceLanguage.value === 'ja' && voice.locale.startsWith('ja'))
      || (selectedVoiceLanguage.value === 'zh' && voice.locale.startsWith('zh'))
      || (selectedVoiceLanguage.value === 'en' && voice.locale.startsWith('en'))
      || voice.locale === selectedVoiceLanguage.value

    const sourceMatched = selectedVoiceSource.value === 'all' || voice.provider === selectedVoiceSource.value
    const searchMatched = !keyword || buildVoiceSearchText(voice).includes(keyword)
    const favoriteMatched = !favoritesOnly.value || isFavoriteVoice(voice.id)
    return languageMatched && sourceMatched && searchMatched && favoriteMatched
  }).sort((left, right) => {
    const leftFavorite = favoriteVoiceIds.value.includes(left.id) ? 1 : 0
    const rightFavorite = favoriteVoiceIds.value.includes(right.id) ? 1 : 0
    if (leftFavorite !== rightFavorite) {
      return rightFavorite - leftFavorite
    }
    return left.display_name.localeCompare(right.display_name, 'zh-CN')
  })
})

const favoriteVoices = computed(() => mapVoiceIdsToOptions(favoriteVoiceIds.value))
const recentVoices = computed(() => mapVoiceIdsToOptions(recentVoiceIds.value))

function mapVoiceIdsToOptions(voiceIds: string[]) {
  const byId = new Map(voiceOptions.value.map((voice) => [voice.id, voice]))
  return voiceIds
    .map((voiceId) => byId.get(normalizeVoiceId(voiceId)))
    .filter((voice): voice is SpeechVoiceOption => Boolean(voice))
}

function normalizeVoiceId(voiceId: string) {
  const availableVoiceIds = new Set(voiceOptions.value.map((voice) => voice.id))
  if (availableVoiceIds.has(voiceId)) {
    return voiceId
  }
  const variantBaseId = `${voiceId}::variant::base`
  if (availableVoiceIds.has(variantBaseId)) {
    return variantBaseId
  }
  return voiceId
}

function normalizeVoiceIds(voiceIds: string[]) {
  return Array.from(new Set(voiceIds.map((voiceId) => normalizeVoiceId(voiceId))))
}

function buildVoiceSearchText(voice: SpeechVoiceOption) {
  return [
    voice.display_name,
    voice.character_name,
    voice.persona_name || '',
    voice.language_label,
    voice.locale,
    voice.source,
    voice.gender || '',
    voice.personality_tags.join(' '),
  ].join(' ').toLowerCase()
}

function readStoredVoiceIds(storageKey: string) {
  try {
    const rawValue = localStorage.getItem(storageKey)
    if (!rawValue) {
      return []
    }
    const parsed = JSON.parse(rawValue)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeStoredVoiceIds(storageKey: string, voiceIds: string[]) {
  localStorage.setItem(storageKey, JSON.stringify(voiceIds))
}

async function syncVoicePreferences(payload: { favoriteVoiceIds: string[]; recentVoiceIds: string[] }, persistNotice?: string) {
  if (!authStore.token) {
    return
  }
  favoriteSaving.value = true
  try {
    const response = await updateSpeechFavoriteVoices({
      favorite_voice_ids: payload.favoriteVoiceIds,
      recent_voice_ids: payload.recentVoiceIds,
    }, authStore.token)
    favoriteVoiceIds.value = response.favorite_voice_ids
    recentVoiceIds.value = response.recent_voice_ids
    writeStoredVoiceIds(FAVORITE_VOICE_STORAGE_KEY, response.favorite_voice_ids)
    writeStoredVoiceIds(RECENT_VOICE_STORAGE_KEY, response.recent_voice_ids)
    if (persistNotice) {
      notice.value = persistNotice
    }
  } finally {
    favoriteSaving.value = false
  }
}

async function toggleFavoriteVoice(voiceId: string) {
  const nextFavorites = favoriteVoiceIds.value.includes(voiceId)
    ? favoriteVoiceIds.value.filter((item) => item !== voiceId)
    : [voiceId, ...favoriteVoiceIds.value]
  try {
    errorMessage.value = ''
    await syncVoicePreferences({
      favoriteVoiceIds: nextFavorites,
      recentVoiceIds: recentVoiceIds.value,
    }, nextFavorites.includes(voiceId) ? '音色已加入收藏' : '已取消收藏音色')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '收藏音色保存失败'
  }
}

async function markVoiceAsRecentlyUsed(voiceId: string | null) {
  if (!voiceId) {
    return
  }
  const nextRecent = [voiceId, ...recentVoiceIds.value.filter((item) => item !== voiceId)].slice(0, MAX_RECENT_VOICES)
  try {
    await syncVoicePreferences({
      favoriteVoiceIds: favoriteVoiceIds.value,
      recentVoiceIds: nextRecent,
    })
  } catch {
    recentVoiceIds.value = nextRecent
    writeStoredVoiceIds(RECENT_VOICE_STORAGE_KEY, nextRecent)
  }
}

function applyVoiceSelection(voiceId: string) {
  selectedVoiceId.value = voiceId
}

function reorderVoiceIds(voiceIds: string[], draggedId: string, targetId: string) {
  if (draggedId === targetId) {
    return voiceIds
  }
  const nextVoiceIds = [...voiceIds]
  const draggedIndex = nextVoiceIds.indexOf(draggedId)
  const targetIndex = nextVoiceIds.indexOf(targetId)
  if (draggedIndex === -1 || targetIndex === -1) {
    return voiceIds
  }
  const [draggedVoiceId] = nextVoiceIds.splice(draggedIndex, 1)
  nextVoiceIds.splice(targetIndex, 0, draggedVoiceId)
  return nextVoiceIds
}

async function persistFavoriteVoiceIds(nextFavoriteVoiceIds: string[], persistNotice?: string) {
  await syncVoicePreferences({
    favoriteVoiceIds: normalizeVoiceIds(nextFavoriteVoiceIds),
    recentVoiceIds: recentVoiceIds.value,
  }, persistNotice)
}

async function persistRecentVoiceIds(nextRecentVoiceIds: string[], persistNotice?: string) {
  await syncVoicePreferences({
    favoriteVoiceIds: favoriteVoiceIds.value,
    recentVoiceIds: normalizeVoiceIds(nextRecentVoiceIds),
  }, persistNotice)
}

async function removeFavoriteVoice(voiceId: string) {
  try {
    errorMessage.value = ''
    await persistFavoriteVoiceIds(favoriteVoiceIds.value.filter((item) => item !== voiceId), '已删除收藏音色')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除收藏音色失败'
  }
}

async function removeRecentVoice(voiceId: string) {
  try {
    errorMessage.value = ''
    await persistRecentVoiceIds(recentVoiceIds.value.filter((item) => item !== voiceId), '已删除最近使用音色')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除最近使用音色失败'
  }
}

async function clearFavoriteVoices() {
  try {
    errorMessage.value = ''
    await persistFavoriteVoiceIds([], '收藏音色已清空')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '清空收藏音色失败'
  }
}

async function clearRecentVoices() {
  try {
    errorMessage.value = ''
    await persistRecentVoiceIds([], '最近使用已清空')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '清空最近使用失败'
  }
}

async function moveFavoriteVoiceToTop(voiceId: string) {
  try {
    errorMessage.value = ''
    const nextFavoriteVoiceIds = [voiceId, ...favoriteVoiceIds.value.filter((item) => item !== voiceId)]
    await persistFavoriteVoiceIds(nextFavoriteVoiceIds, '收藏音色排序已更新')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '收藏音色排序失败'
  }
}

async function moveRecentVoiceToTop(voiceId: string) {
  try {
    errorMessage.value = ''
    const nextRecentVoiceIds = [voiceId, ...recentVoiceIds.value.filter((item) => item !== voiceId)]
    await persistRecentVoiceIds(nextRecentVoiceIds, '最近使用排序已更新')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '最近使用排序失败'
  }
}

async function moveFavoriteVoiceUp(voiceId: string) {
  const currentIndex = favoriteVoiceIds.value.indexOf(voiceId)
  if (currentIndex <= 0) {
    return
  }
  const nextFavoriteVoiceIds = [...favoriteVoiceIds.value]
  ;[nextFavoriteVoiceIds[currentIndex - 1], nextFavoriteVoiceIds[currentIndex]] = [nextFavoriteVoiceIds[currentIndex], nextFavoriteVoiceIds[currentIndex - 1]]
  try {
    errorMessage.value = ''
    await persistFavoriteVoiceIds(nextFavoriteVoiceIds, '收藏音色排序已更新')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '收藏音色排序失败'
  }
}

async function moveRecentVoiceUp(voiceId: string) {
  const currentIndex = recentVoiceIds.value.indexOf(voiceId)
  if (currentIndex <= 0) {
    return
  }
  const nextRecentVoiceIds = [...recentVoiceIds.value]
  ;[nextRecentVoiceIds[currentIndex - 1], nextRecentVoiceIds[currentIndex]] = [nextRecentVoiceIds[currentIndex], nextRecentVoiceIds[currentIndex - 1]]
  try {
    errorMessage.value = ''
    await persistRecentVoiceIds(nextRecentVoiceIds, '最近使用排序已更新')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '最近使用排序失败'
  }
}

function handleVoiceDragStart(section: 'favorite' | 'recent', voiceId: string) {
  dragSection.value = section
  dragVoiceId.value = voiceId
}

function handleVoiceDragEnd() {
  dragSection.value = null
  dragVoiceId.value = null
}

async function handleVoiceDrop(section: 'favorite' | 'recent', targetVoiceId: string) {
  if (!dragVoiceId.value || dragSection.value !== section) {
    handleVoiceDragEnd()
    return
  }

  try {
    errorMessage.value = ''
    if (section === 'favorite') {
      const nextFavoriteVoiceIds = reorderVoiceIds(favoriteVoiceIds.value, dragVoiceId.value, targetVoiceId)
      await persistFavoriteVoiceIds(nextFavoriteVoiceIds, '收藏音色排序已更新')
    } else {
      const nextRecentVoiceIds = reorderVoiceIds(recentVoiceIds.value, dragVoiceId.value, targetVoiceId)
      await persistRecentVoiceIds(nextRecentVoiceIds, '最近使用排序已更新')
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '音色排序失败'
  } finally {
    handleVoiceDragEnd()
  }
}

function isFavoriteVoice(voiceId: string) {
  const normalizedVoiceId = normalizeVoiceId(voiceId)
  return normalizeVoiceIds(favoriteVoiceIds.value).includes(normalizedVoiceId)
}

async function loadOptions() {
  if (!authStore.token) {
    return
  }
  const response = await getSpeechGenerationOptions(authStore.token)
  voiceOptions.value = response.voices
  speedOptions.value = response.speeds
  const normalizedFavoriteVoiceIds = normalizeVoiceIds(response.favorite_voice_ids)
  const normalizedRecentVoiceIds = normalizeVoiceIds(response.recent_voice_ids)
  favoriteVoiceIds.value = normalizedFavoriteVoiceIds
  recentVoiceIds.value = normalizedRecentVoiceIds
  if (normalizedFavoriteVoiceIds.join('|') !== response.favorite_voice_ids.join('|')) {
    await syncVoicePreferences({
      favoriteVoiceIds: normalizedFavoriteVoiceIds,
      recentVoiceIds: normalizedRecentVoiceIds,
    })
    return
  }
  if (normalizedRecentVoiceIds.join('|') !== response.recent_voice_ids.join('|')) {
    await syncVoicePreferences({
      favoriteVoiceIds: normalizedFavoriteVoiceIds,
      recentVoiceIds: normalizedRecentVoiceIds,
    })
    return
  }
  if ((!normalizedFavoriteVoiceIds.length && pendingLegacyFavoriteVoiceIds.value.length) || (!normalizedRecentVoiceIds.length && recentVoiceIds.value.length)) {
    await syncVoicePreferences({
      favoriteVoiceIds: normalizedFavoriteVoiceIds.length ? normalizedFavoriteVoiceIds : normalizeVoiceIds(pendingLegacyFavoriteVoiceIds.value),
      recentVoiceIds: normalizedRecentVoiceIds.length ? normalizedRecentVoiceIds : normalizeVoiceIds(readStoredVoiceIds(RECENT_VOICE_STORAGE_KEY)),
    })
  }
}

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
        voiceId: selectedVoiceId.value || null,
        speedRate: selectedSpeedRate.value,
        document: selectedDocument.value,
      },
      authStore.token,
    )
    notice.value = `语音生成完成，识别语言为 ${response.language_label}`
    languageLabel.value = response.language_label
    await markVoiceAsRecentlyUsed(selectedVoiceId.value || null)
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
  pendingLegacyFavoriteVoiceIds.value = readStoredVoiceIds(FAVORITE_VOICE_STORAGE_KEY)
  recentVoiceIds.value = readStoredVoiceIds(RECENT_VOICE_STORAGE_KEY)
  Promise.all([loadOptions(), loadRecords()]).catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '加载语音生成记录失败'
  })
})

watch(notice, () => {
  scheduleMessageClear('notice')
})

watch(errorMessage, () => {
  scheduleMessageClear('error')
})

onUnmounted(() => {
  if (audioUrl.value) {
    URL.revokeObjectURL(audioUrl.value)
  }
  resetMessageTimer('notice')
  resetMessageTimer('error')
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
        <div class="style-grid">
          <label>
            语言筛选
            <select v-model="selectedVoiceLanguage">
              <option v-for="option in voiceLanguageOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label>
            来源筛选
            <select v-model="selectedVoiceSource">
              <option v-for="option in voiceSourceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
        </div>
        <div class="voice-filter-toggle">
          <label class="toggle-row">
            <input v-model="favoritesOnly" type="checkbox" />
            <span>只看收藏</span>
          </label>
        </div>
        <label>
          关键词搜索
          <input v-model="voiceSearchKeyword" type="text" placeholder="输入人物名、场景名、语言或来源，例如 Nanami、明亮、系统内置" />
        </label>
        <div class="form-grid" style="gap: 12px;">
          <div v-if="favoriteVoices.length" class="voice-shortcuts">
            <div class="voice-shortcuts__header">
              <p class="helper-text">收藏音色</p>
              <button class="ghost-button voice-shortcuts__clear" type="button" :disabled="favoriteSaving" @click="clearFavoriteVoices">清空</button>
            </div>
            <div class="voice-shortcuts__list">
              <div
                v-for="voice in favoriteVoices"
                :key="`favorite-${voice.id}`"
                class="voice-shortcuts__item"
                draggable="true"
                @dragstart="handleVoiceDragStart('favorite', voice.id)"
                @dragend="handleVoiceDragEnd"
                @dragover.prevent
                @drop.prevent="handleVoiceDrop('favorite', voice.id)"
              >
                <button class="voice-shortcuts__remove" type="button" :disabled="favoriteSaving" @click="removeFavoriteVoice(voice.id)">×</button>
                <button class="ghost-button voice-shortcuts__select" type="button" @click="applyVoiceSelection(voice.id)">
                  {{ voice.character_name }}{{ voice.persona_name ? ` / ${voice.persona_name}` : '' }}
                </button>
                <div class="voice-shortcuts__actions">
                  <button class="secondary-button voice-shortcuts__action" type="button" :disabled="favoriteSaving" @click="moveFavoriteVoiceToTop(voice.id)">置顶</button>
                  <button class="secondary-button voice-shortcuts__action" type="button" :disabled="favoriteSaving" @click="moveFavoriteVoiceUp(voice.id)">上移</button>
                </div>
              </div>
            </div>
          </div>
          <div v-if="recentVoices.length" class="voice-shortcuts">
            <div class="voice-shortcuts__header">
              <p class="helper-text">最近使用</p>
              <button class="ghost-button voice-shortcuts__clear" type="button" :disabled="favoriteSaving" @click="clearRecentVoices">清空</button>
            </div>
            <div class="voice-shortcuts__list">
              <div
                v-for="voice in recentVoices"
                :key="`recent-${voice.id}`"
                class="voice-shortcuts__item voice-shortcuts__item--recent"
                draggable="true"
                @dragstart="handleVoiceDragStart('recent', voice.id)"
                @dragend="handleVoiceDragEnd"
                @dragover.prevent
                @drop.prevent="handleVoiceDrop('recent', voice.id)"
              >
                <button class="voice-shortcuts__remove" type="button" :disabled="favoriteSaving" @click="removeRecentVoice(voice.id)">×</button>
                <button class="secondary-button voice-shortcuts__select" type="button" @click="applyVoiceSelection(voice.id)">
                  {{ voice.character_name }}{{ voice.persona_name ? ` / ${voice.persona_name}` : '' }}
                </button>
                <div class="voice-shortcuts__actions">
                  <button class="ghost-button voice-shortcuts__action" type="button" :disabled="favoriteSaving" @click="moveRecentVoiceToTop(voice.id)">置顶</button>
                  <button class="ghost-button voice-shortcuts__action" type="button" :disabled="favoriteSaving" @click="moveRecentVoiceUp(voice.id)">上移</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="style-grid">
          <label>
            人物声音
            <select v-model="selectedVoiceId">
              <option value="">自动选择推荐音色</option>
              <option v-for="voice in filteredVoiceOptions" :key="voice.id" :value="voice.id">
                {{ voice.character_name }}{{ voice.persona_name ? ` / ${voice.persona_name}` : '' }} / {{ voice.language_label }} / {{ voice.source }}{{ voice.gender ? ` / ${voice.gender}` : '' }}
              </option>
            </select>
            <div class="table-actions" style="margin-top: 8px;" v-if="selectedVoiceId">
              <button class="ghost-button" type="button" :disabled="favoriteSaving" @click="toggleFavoriteVoice(selectedVoiceId)">
                {{ isFavoriteVoice(selectedVoiceId) ? '取消收藏当前音色' : '收藏当前音色' }}
              </button>
            </div>
          </label>
          <label>
            语音速度
            <select v-model.number="selectedSpeedRate">
              <option v-for="speed in speedOptions" :key="speed.value" :value="speed.value">{{ speed.label }}</option>
            </select>
          </label>
        </div>
        <p class="helper-text">当前匹配音色 {{ filteredVoiceOptions.length }} 个。日语音色已扩展为“人物名称 + 场景变体”，可先筛选再搜索。</p>
        <div class="toolbar">
          <button class="primary-button" type="button" :disabled="loading" @click="handleGenerate">
            {{ loading ? '生成中...' : '生成语音' }}
          </button>
          <span class="status-badge" v-if="selectedDocument">{{ selectedDocument.name }}</span>
          <span class="status-badge">识别语言: {{ languageLabel }}</span>
        </div>
      </div>
    </section>

    <Transition name="message-fade">
      <p v-if="notice" class="success-box">{{ notice }}</p>
    </Transition>
    <Transition name="message-fade">
      <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>
    </Transition>

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

<style scoped>
.voice-shortcuts {
  display: grid;
  gap: 10px;
}

.voice-shortcuts__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.voice-shortcuts__header .helper-text {
  margin: 0;
}

.voice-shortcuts__clear {
  padding: 6px 12px;
}

.voice-shortcuts__list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.voice-shortcuts__item {
  position: relative;
  display: grid;
  gap: 8px;
  min-width: 220px;
  max-width: 100%;
  padding: 14px 14px 12px;
  border-radius: 18px;
  border: 1px solid rgba(83, 61, 39, 0.12);
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 12px 30px rgba(72, 45, 20, 0.08);
}

.voice-shortcuts__item--recent {
  background: rgba(247, 251, 251, 0.88);
}

.voice-shortcuts__remove {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  background: rgba(180, 35, 24, 0.12);
  color: var(--danger);
  font-size: 1rem;
  line-height: 1;
}

.voice-shortcuts__select {
  width: 100%;
  text-align: left;
  padding-right: 34px;
}

.voice-shortcuts__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.voice-shortcuts__action {
  padding: 6px 12px;
}

.voice-filter-toggle {
  display: flex;
  align-items: center;
}

.voice-filter-toggle .toggle-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
</style>
