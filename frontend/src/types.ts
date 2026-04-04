export interface User {
  id: number
  username: string
  full_name: string | null
  email: string | null
  role: string
  is_active: boolean
  can_upload: boolean
  can_manage_files: boolean
  can_manage_users: boolean
  can_manage_settings: boolean
  can_view_audit_logs: boolean
  created_at: string
}

export interface UploadRecord {
  id: number
  original_filename: string
  source_type: string
  batch_id: string | null
  file_size: number
  detected_language: string | null
  transcript_text: string | null
  error_message: string | null
  status: string
  created_at: string
  updated_at: string
  user_id: number
}

export interface TranscriptionResult {
  upload: UploadRecord
  language_label: string
  text: string
}

export interface BatchTranscriptionAccepted {
  batch_id: string
  uploads: UploadRecord[]
}

export interface UploadSetting {
  max_upload_size_mb: number
}

export interface SpeechLanguageSettings {
  max_upload_size_mb: number
  japanese_tts_dictionary: Record<string, string>
  japanese_transcript_corrections: Record<string, string>
}

export interface AuditLog {
  id: number
  action: string
  resource_type: string
  resource_id: number | null
  details: string | null
  created_at: string
  user_id: number | null
}

export interface SpeechGenerationRecord {
  id: number
  source_type: string
  original_filename: string | null
  input_text: string
  detected_language: string
  style: string
  voice_name: string
  stored_filename: string
  file_size: number
  created_at: string
  user_id: number
}

export interface SpeechGenerationCreateResponse {
  record: SpeechGenerationRecord
  language_label: string
  audio_download_url: string
}
