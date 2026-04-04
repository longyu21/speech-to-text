<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  upload: [files: File[]]
}>()

const selectedFiles = ref<File[]>([])

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  selectedFiles.value = Array.from(target.files ?? [])
}

function submitUpload() {
  if (!selectedFiles.value.length) {
    return
  }
  emit('upload', selectedFiles.value)
}
</script>

<template>
  <section class="panel">
    <div class="hero-card">
      <div>
        <p class="eyebrow">Upload</p>
        <h2>上传语音文件</h2>
        <p class="helper-text">
          支持中文、日语、英文语音自动识别，也支持字幕文件直接导入文本。
        </p>
      </div>
      <div class="metric-row">
        <article class="metric">
          <span class="muted">识别方式</span>
          <strong>自动语言检测</strong>
        </article>
        <article class="metric">
          <span class="muted">导出格式</span>
          <strong>Word .docx</strong>
        </article>
      </div>
    </div>
    <div class="dropzone">
      <div class="form-grid">
        <label>
          选择音频、视频或字幕文件
          <input type="file" multiple accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4,.webm,.mov,.mkv,.avi,.wmv,.mpeg,.mpg,.3gp,.m4v,.srt,.vtt,.ass,.ssa,.lrc" @change="handleFileChange" />
        </label>
        <p class="helper-text">支持音频、视频和字幕文件单文件或批量上传。视频会先自动提取音轨，字幕文件会直接导入为文本。</p>
        <div class="toolbar">
          <button class="primary-button" type="button" :disabled="!selectedFiles.length" @click="submitUpload">
            {{ selectedFiles.length > 1 ? `批量入队 ${selectedFiles.length} 个文件` : '开始转写' }}
          </button>
          <span class="status-badge" v-if="selectedFiles.length">已选择 {{ selectedFiles.length }} 个文件</span>
        </div>
        <div class="tag-list" v-if="selectedFiles.length">
          <span v-for="file in selectedFiles" :key="file.name + file.size" class="status-badge">{{ file.name }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
