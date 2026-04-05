import type { AuditLog, BatchTranscriptionAccepted, SpeechFavoriteVoices, SpeechGenerationCreateResponse, SpeechGenerationOptions, SpeechGenerationRecord, SpeechLanguageSettings, TranscriptCorrectionPayload, TranscriptTranslationResult, TranslationLanguage, TranscriptionResult, UploadRecord, UploadSetting, User } from '@/types'

const API_HOST = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname
const API_BASE_URL = `http://${API_HOST}:8000/api`

interface DownloadPayload {
  blob: Blob
  filename: string | null
}

type UploadSourceScope = 'all' | 'local' | 'url'

interface DownloadTranscriptTextOptions {
  includeTranslation?: boolean
  targetLanguage?: TranslationLanguage
}

interface DownloadTranscriptOptions {
  includeTranslation?: boolean
  targetLanguage?: TranslationLanguage
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers)
  if (!(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(translateApiError(path, data.detail || 'Request failed'))
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export function login(username: string, password: string) {
  return request<{ access_token: string; token_type: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function register(payload: Record<string, unknown>) {
  return request<{ message: string }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getCurrentUser(token: string) {
  return request<User>('/auth/me', {}, token)
}

export function listUploads(token: string, sourceScope: UploadSourceScope = 'all') {
  const query = sourceScope === 'all' ? '' : `?source_scope=${encodeURIComponent(sourceScope)}`
  return request<UploadRecord[]>(`/transcriptions${query}`, {}, token)
}

export function uploadAudio(file: File, token: string) {
  const formData = new FormData()
  formData.append('file', file)
  return request<TranscriptionResult>('/transcriptions/upload', {
    method: 'POST',
    body: formData,
  }, token)
}

export function batchUploadAudio(files: File[], token: string) {
  const formData = new FormData()
  files.forEach((file) => formData.append('files', file))
  return request<BatchTranscriptionAccepted>('/transcriptions/batch-upload', {
    method: 'POST',
    body: formData,
  }, token)
}

export function createUrlTranscription(url: string, token: string) {
  return request<TranscriptionResult>('/transcriptions/url', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }, token)
}

export async function downloadTranscript(uploadId: number, token: string, options: DownloadTranscriptOptions = {}) {
  const searchParams = new URLSearchParams()
  if (options.includeTranslation) {
    searchParams.set('include_translation', 'true')
    if (options.targetLanguage) {
      searchParams.set('target_language', options.targetLanguage)
    }
  }
  const query = searchParams.size ? `?${searchParams.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/transcriptions/${uploadId}/download${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: 'Download failed' }))
    throw new Error(translateApiError(`/transcriptions/${uploadId}/download`, data.detail || 'Download failed'))
  }

  return buildDownloadPayload(response)
}

export function getTranslatedTranscript(uploadId: number, targetLanguage: TranslationLanguage, token: string) {
  return request<TranscriptTranslationResult>(`/transcriptions/${uploadId}/translation?target_language=${encodeURIComponent(targetLanguage)}`, {}, token)
}

export function updateTranscriptCorrection(uploadId: number, payload: TranscriptCorrectionPayload, token: string) {
  return request<UploadRecord>(`/transcriptions/${uploadId}/text`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  }, token)
}

export async function downloadTranscriptText(uploadId: number, token: string, options: DownloadTranscriptTextOptions = {}) {
  const searchParams = new URLSearchParams()
  if (options.includeTranslation) {
    searchParams.set('include_translation', 'true')
    if (options.targetLanguage) {
      searchParams.set('target_language', options.targetLanguage)
    }
  }
  const query = searchParams.size ? `?${searchParams.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/transcriptions/${uploadId}/download-text${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: 'Text download failed' }))
    throw new Error(translateApiError(`/transcriptions/${uploadId}/download-text`, data.detail || 'Text download failed'))
  }

  return buildDownloadPayload(response)
}

export function buildUploadMediaUrl(uploadId: number, token: string) {
  const encodedToken = encodeURIComponent(token)
  return `${API_BASE_URL}/transcriptions/${uploadId}/media?token=${encodedToken}`
}

export function listUsers(token: string) {
  return request<User[]>('/admin/users', {}, token)
}

export function listAuditLogs(token: string) {
  return request<AuditLog[]>('/admin/audit-logs', {}, token)
}

export function createUser(payload: Record<string, unknown>, token: string) {
  return request<User>('/admin/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token)
}

export function updateUser(userId: number, payload: Record<string, unknown>, token: string) {
  return request<User>(`/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  }, token)
}

export function deleteUser(userId: number, token: string) {
  return request<void>(`/admin/users/${userId}`, {
    method: 'DELETE',
  }, token)
}

export function getUploadSetting(token: string) {
  return request<UploadSetting>('/admin/settings/upload', {}, token)
}

export function getSpeechLanguageSettings(token: string) {
  return request<SpeechLanguageSettings>('/admin/settings/speech-language', {}, token)
}

export function updateUploadSetting(maxUploadSizeMb: number, token: string) {
  return request<UploadSetting>('/admin/settings/upload', {
    method: 'PUT',
    body: JSON.stringify({ max_upload_size_mb: maxUploadSizeMb }),
  }, token)
}

export function updateSpeechLanguageSettings(payload: SpeechLanguageSettings, token: string) {
  return request<SpeechLanguageSettings>('/admin/settings/speech-language', {
    method: 'PUT',
    body: JSON.stringify(payload),
  }, token)
}

export function retryUpload(uploadId: number, token: string) {
  return request<UploadRecord>(`/transcriptions/${uploadId}/retry`, {
    method: 'POST',
  }, token)
}

export function deleteUpload(uploadId: number, token: string) {
  return request<void>(`/transcriptions/${uploadId}`, {
    method: 'DELETE',
  }, token)
}

export function listSpeechGenerations(token: string) {
  return request<SpeechGenerationRecord[]>('/speech-generations', {}, token)
}

export function getSpeechGenerationOptions(token: string) {
  return request<SpeechGenerationOptions>('/speech-generations/options', {}, token)
}

export function getSpeechFavoriteVoices(token: string) {
  return request<SpeechFavoriteVoices>('/speech-generations/preferences', {}, token)
}

export function updateSpeechFavoriteVoices(payload: SpeechFavoriteVoices, token: string) {
  return request<SpeechFavoriteVoices>('/speech-generations/preferences', {
    method: 'PUT',
    body: JSON.stringify(payload),
  }, token)
}

export function createSpeechGeneration(payload: { text?: string; style: string; outputFormat: string; voiceId?: string | null; speedRate: number; document?: File | null }, token: string) {
  const formData = new FormData()
  if (payload.text) {
    formData.append('text', payload.text)
  }
  formData.append('style', payload.style)
  formData.append('output_format', payload.outputFormat)
  formData.append('speed_rate', String(payload.speedRate))
  if (payload.voiceId) {
    formData.append('voice_id', payload.voiceId)
  }
  if (payload.document) {
    formData.append('document', payload.document)
  }
  return request<SpeechGenerationCreateResponse>('/speech-generations/generate', {
    method: 'POST',
    body: formData,
  }, token)
}

export async function fetchSpeechAudio(recordId: number, token: string) {
  const response = await fetch(`${API_BASE_URL}/speech-generations/${recordId}/audio`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: 'Audio fetch failed' }))
    throw new Error(translateApiError(`/speech-generations/${recordId}/audio`, data.detail || 'Audio fetch failed'))
  }
  return response.blob()
}

export async function downloadSpeechAudio(recordId: number, token: string) {
  const response = await fetch(`${API_BASE_URL}/speech-generations/${recordId}/download`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: 'Audio download failed' }))
    throw new Error(translateApiError(`/speech-generations/${recordId}/download`, data.detail || 'Audio download failed'))
  }
  return buildDownloadPayload(response)
}

export function deleteSpeechGeneration(recordId: number, token: string) {
  return request<void>(`/speech-generations/${recordId}`, {
    method: 'DELETE',
  }, token)
}

async function buildDownloadPayload(response: Response): Promise<DownloadPayload> {
  const blob = await response.blob()
  return {
    blob,
    filename: parseDownloadFilename(response.headers.get('content-disposition')),
  }
}

function parseDownloadFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null
  }
  const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (encodedMatch?.[1]) {
    return decodeURIComponent(encodedMatch[1])
  }
  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1] ?? null
}

function translateApiError(path: string, detail: string): string {
  const normalized = detail.trim()

  if (path.includes('/transcriptions/url')) {
    if (normalized === 'Downloaded media exceeds configured upload limit') {
      return 'URL 对应的媒体文件超过系统上传大小限制。'
    }
    if (normalized === 'Downloaded media format is not supported for transcription') {
      return 'URL 解析成功，但下载到的媒体格式当前不支持转写。'
    }
    if (normalized === 'Downloaded media file could not be located') {
      return 'URL 解析失败，未能定位下载后的媒体文件。'
    }
    if (normalized === 'Unable to resolve downloaded media path') {
      return 'URL 解析失败，下载后的媒体路径不可用。'
    }
    if (normalized.startsWith('无法解密 Chromium 浏览器里的登录 Cookie。')) {
      return normalized
    }
    if (normalized.startsWith('YouTube 当前要求登录态验证。')) {
      return normalized
    }
    if (normalized === 'Only completed transcripts can be edited') {
      return '仅已完成的转写记录支持文本修正。'
    }
    if (normalized === 'Edited transcript cannot be empty') {
      return '修正后的文本不能为空。'
    }
    return `URL 解析失败：${normalized}`
  }

  if (path.includes('/transcriptions/') && path.endsWith('/retry')) {
    if (normalized === 'Only failed, paused, or completed tasks can be retried') {
      return '仅失败、已暂停或已完成的任务支持重试。'
    }
    return `任务重试失败：${normalized}`
  }

  if (path.includes('/transcriptions/') && path.endsWith('/text')) {
    if (normalized === 'Only completed transcripts can be edited') {
      return '仅已完成的转写记录支持文本修正。'
    }
    if (normalized === 'Edited transcript cannot be empty') {
      return '修正后的文本不能为空。'
    }
    if (normalized === 'Transcript not available') {
      return '当前记录还没有可修正的文本内容。'
    }
    return `文本修正失败：${normalized}`
  }

  if (path.includes('/transcriptions/upload') || path.includes('/transcriptions/batch-upload')) {
    if (normalized.startsWith('Unsupported media format:')) {
      const fileMatch = normalized.match(/^Unsupported media format:\s*(.+?)(?:\. Supported formats:|$)/)
      const supportedMatch = normalized.match(/Supported formats:\s*(.+)$/)
      return supportedMatch
        ? `不支持的上传格式：${fileMatch?.[1] ?? '该文件'}。可上传格式：${supportedMatch[1]}`
        : `不支持的上传格式：${fileMatch?.[1] ?? '该文件'}。`
    }
    if (normalized.startsWith('Uploaded file is empty:')) {
      return normalized.replace('Uploaded file is empty:', '上传失败，文件为空，请确认文件已正确导出：').trim()
    }
    if (normalized.startsWith('File exceeds configured upload limit:')) {
      return normalized.replace('File exceeds configured upload limit:', '上传失败，文件超过系统上传大小限制，请压缩或更换文件：').trim()
    }
    const invalidFileMatch = normalized.match(/^Invalid file\s+(.+?):\s+(.+)$/)
    if (invalidFileMatch) {
      const [, filename, reason] = invalidFileMatch
      if (reason.startsWith('MIME type does not match audio file')) {
        const mime = reason.split(':').slice(1).join(':').trim()
        return mime
          ? `文件校验失败：${filename}，文件后缀看起来是音频，但浏览器识别到的类型是 ${mime}。`
          : `文件校验失败：${filename}，文件后缀看起来是音频，但实际类型不匹配。`
      }
      if (reason.startsWith('MIME type does not match video file')) {
        const mime = reason.split(':').slice(1).join(':').trim()
        return mime
          ? `文件校验失败：${filename}，文件后缀看起来是视频，但浏览器识别到的类型是 ${mime}。`
          : `文件校验失败：${filename}，文件后缀看起来是视频，但实际类型不匹配。`
      }
      if (reason.startsWith('MIME type does not match subtitle file')) {
        const mime = reason.split(':').slice(1).join(':').trim()
        return mime
          ? `文件校验失败：${filename}，文件后缀看起来是字幕，但浏览器识别到的类型是 ${mime}。`
          : `文件校验失败：${filename}，文件后缀看起来是字幕，但实际类型不匹配。`
      }
      if (reason === 'File content does not match the selected extension') {
        return `文件校验失败：${filename}，文件扩展名与实际内容不一致，请确认没有手动改过后缀名。`
      }
      if (reason === 'Subtitle file does not contain readable text') {
        return `文件校验失败：${filename}，字幕文件里没有识别到可导入的正文内容。`
      }
      return `文件校验失败：${filename}，${reason}`
    }
    if (normalized.startsWith('No readable subtitle text found:')) {
      return normalized.replace('No readable subtitle text found:', '字幕文件中未找到可导入文本，请检查文件内容：').trim()
    }
    if (normalized === 'No files provided') {
      return '未选择任何文件。'
    }
  }

  if (path.includes('/download-text') && normalized === 'Transcript not available') {
    return '当前记录尚未生成可下载的文本。'
  }

  if (path.includes('/download-text') && normalized === 'Target language is required when translation is enabled') {
    return '启用翻译下载时必须选择目标语言。'
  }

  if (path.includes('/translation') || path.includes('/download-text')) {
    if (normalized === 'Unsupported translation language') {
      return '当前只支持翻译为中文、日语或英语。'
    }
    if (normalized.startsWith('Translation failed:')) {
      return '翻译服务暂时不可用，请稍后重试。'
    }
  }

  if (path.includes('/speech-generations/generate')) {
    if (normalized === 'Uploaded document is empty') {
      return '上传失败，文档内容为空，请重新选择文档。'
    }
    if (normalized === 'No readable text found in document') {
      return '文档中未识别到可用于生成语音的正文内容。'
    }
    if (normalized === 'Unsupported document format') {
      return '当前文档格式不支持生成语音，请上传 txt、md 或 docx 文件。'
    }
    if (normalized === 'Please provide text or upload a document') {
      return '请输入文本或上传文档后再生成语音。'
    }
    if (normalized === 'Unsupported speech output format') {
      return '不支持当前选择的语音导出格式。'
    }
    if (normalized === 'Unsupported voice selection') {
      return '当前选择的音色不受支持，请重新选择。'
    }
    if (normalized === 'Selected system voice is not available') {
      return '当前选择的系统音色不可用，请重新选择。'
    }
    if (normalized.startsWith('Speech synthesis failed:')) {
      return '语音生成失败，语音引擎暂时无法处理当前内容，请稍后重试。'
    }
  }

  if (path.includes('/speech-generations')) {
    if (normalized === 'Generated audio file not found') {
      return '生成的音频文件不存在，可能已被删除，请重新生成。'
    }
    if (normalized === 'Generated speech record not found') {
      return '语音记录不存在，可能已被删除。'
    }
    if (normalized === 'Not allowed') {
      return '你没有权限执行这个操作。'
    }
    if (normalized === 'Audio fetch failed') {
      return '获取音频失败，请稍后重试。'
    }
    if (normalized === 'Audio download failed') {
      return '下载音频失败，请稍后重试。'
    }
  }

  if (path.includes('/admin/settings')) {
    if (normalized === 'Upload size must be greater than zero') {
      return '上传大小必须大于 0。'
    }
  }

  if (normalized === 'Request failed') {
    return '请求失败，请稍后重试。'
  }

  return normalized
}
