<script setup lang="ts">
import { ref, watch } from 'vue'

import type { SpeechLanguageSettings } from '@/types'

const props = defineProps<{
  setting: SpeechLanguageSettings | null
}>()

const emit = defineEmits<{
  save: [payload: SpeechLanguageSettings]
}>()

const uploadSize = ref(100)
const japaneseTtsDictionary = ref('')
const japaneseTranscriptCorrections = ref('')

watch(
  () => props.setting,
  (value: SpeechLanguageSettings | null) => {
    if (value) {
      uploadSize.value = value.max_upload_size_mb
      japaneseTtsDictionary.value = formatDictionaryEntries(value.japanese_tts_dictionary)
      japaneseTranscriptCorrections.value = formatDictionaryEntries(value.japanese_transcript_corrections)
    }
  },
  { immediate: true },
)

function formatDictionaryEntries(entries: Record<string, string>) {
  return Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right, 'ja-JP'))
    .map(([term, reading]) => `${term} = ${reading}`)
    .join('\n')
}

function parseDictionaryEntries(rawValue: string) {
  const result: Record<string, string> = {}
  for (const rawLine of rawValue.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const delimiterIndex = line.includes('=') ? line.indexOf('=') : line.indexOf(':')
    if (delimiterIndex === -1) {
      continue
    }
    const key = line.slice(0, delimiterIndex).trim()
    const value = line.slice(delimiterIndex + 1).trim()
    if (key && value) {
      result[key] = value
    }
  }
  return result
}

function handleSave() {
  emit('save', {
    max_upload_size_mb: uploadSize.value,
    japanese_tts_dictionary: parseDictionaryEntries(japaneseTtsDictionary.value),
    japanese_transcript_corrections: parseDictionaryEntries(japaneseTranscriptCorrections.value),
  })
}
</script>

<template>
  <section class="panel">
    <p class="eyebrow">Setting</p>
    <h2>语音与转写设置</h2>
    <div class="form-grid" style="margin-top: 18px;">
      <label>
        最大上传文件大小（MB）
        <input v-model.number="uploadSize" type="number" min="1" />
      </label>
      <label>
        日文 TTS 读音词典
        <textarea v-model="japaneseTtsDictionary" rows="8" placeholder="术语 = 读音&#10;例：胡さん = こさん"></textarea>
      </label>
      <label>
        日语转写纠错词典
        <textarea v-model="japaneseTranscriptCorrections" rows="8" placeholder="错误词 = 正确词&#10;例：子さん = 胡さん"></textarea>
      </label>
      <button class="primary-button" type="button" @click="handleSave">保存设置</button>
      <p class="helper-text">上传大小会影响全站上传校验。两份词典支持每行一条，使用 = 或 : 分隔，保存后会立即作用于后端。</p>
    </div>
  </section>
</template>
