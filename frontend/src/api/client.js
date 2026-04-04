const API_HOST = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname;
const API_BASE_URL = `http://${API_HOST}:8000/api`;
async function request(path, options = {}, token) {
    const headers = new Headers(options.headers);
    if (!(options.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
    }
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    const response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers,
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(translateApiError(path, data.detail || 'Request failed'));
    }
    if (response.status === 204) {
        return undefined;
    }
    return response.json();
}
export function login(username, password) {
    return request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
    });
}
export function register(payload) {
    return request('/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}
export function getCurrentUser(token) {
    return request('/auth/me', {}, token);
}
export function listUploads(token) {
    return request('/transcriptions', {}, token);
}
export function uploadAudio(file, token) {
    const formData = new FormData();
    formData.append('file', file);
    return request('/transcriptions/upload', {
        method: 'POST',
        body: formData,
    }, token);
}
export function batchUploadAudio(files, token) {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    return request('/transcriptions/batch-upload', {
        method: 'POST',
        body: formData,
    }, token);
}
export async function downloadTranscript(uploadId, token) {
    const response = await fetch(`${API_BASE_URL}/transcriptions/${uploadId}/download`, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({ detail: 'Download failed' }));
        throw new Error(translateApiError(`/transcriptions/${uploadId}/download`, data.detail || 'Download failed'));
    }
    return buildDownloadPayload(response);
}
export function listUsers(token) {
    return request('/admin/users', {}, token);
}
export function listAuditLogs(token) {
    return request('/admin/audit-logs', {}, token);
}
export function createUser(payload, token) {
    return request('/admin/users', {
        method: 'POST',
        body: JSON.stringify(payload),
    }, token);
}
export function updateUser(userId, payload, token) {
    return request(`/admin/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
    }, token);
}
export function deleteUser(userId, token) {
    return request(`/admin/users/${userId}`, {
        method: 'DELETE',
    }, token);
}
export function getUploadSetting(token) {
    return request('/admin/settings/upload', {}, token);
}
export function getSpeechLanguageSettings(token) {
    return request('/admin/settings/speech-language', {}, token);
}
export function updateUploadSetting(maxUploadSizeMb, token) {
    return request('/admin/settings/upload', {
        method: 'PUT',
        body: JSON.stringify({ max_upload_size_mb: maxUploadSizeMb }),
    }, token);
}
export function updateSpeechLanguageSettings(payload, token) {
    return request('/admin/settings/speech-language', {
        method: 'PUT',
        body: JSON.stringify(payload),
    }, token);
}
export function retryUpload(uploadId, token) {
    return request(`/transcriptions/${uploadId}/retry`, {
        method: 'POST',
    }, token);
}
export function deleteUpload(uploadId, token) {
    return request(`/transcriptions/${uploadId}`, {
        method: 'DELETE',
    }, token);
}
export function listSpeechGenerations(token) {
    return request('/speech-generations', {}, token);
}
export function createSpeechGeneration(payload, token) {
    const formData = new FormData();
    if (payload.text) {
        formData.append('text', payload.text);
    }
    formData.append('style', payload.style);
    formData.append('output_format', payload.outputFormat);
    if (payload.document) {
        formData.append('document', payload.document);
    }
    return request('/speech-generations/generate', {
        method: 'POST',
        body: formData,
    }, token);
}
export async function fetchSpeechAudio(recordId, token) {
    const response = await fetch(`${API_BASE_URL}/speech-generations/${recordId}/audio`, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({ detail: 'Audio fetch failed' }));
        throw new Error(translateApiError(`/speech-generations/${recordId}/audio`, data.detail || 'Audio fetch failed'));
    }
    return response.blob();
}
export async function downloadSpeechAudio(recordId, token) {
    const response = await fetch(`${API_BASE_URL}/speech-generations/${recordId}/download`, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({ detail: 'Audio download failed' }));
        throw new Error(translateApiError(`/speech-generations/${recordId}/download`, data.detail || 'Audio download failed'));
    }
    return buildDownloadPayload(response);
}
export function deleteSpeechGeneration(recordId, token) {
    return request(`/speech-generations/${recordId}`, {
        method: 'DELETE',
    }, token);
}
async function buildDownloadPayload(response) {
    const blob = await response.blob();
    return {
        blob,
        filename: parseDownloadFilename(response.headers.get('content-disposition')),
    };
}
function parseDownloadFilename(contentDisposition) {
    if (!contentDisposition) {
        return null;
    }
    const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (encodedMatch?.[1]) {
        return decodeURIComponent(encodedMatch[1]);
    }
    const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    return plainMatch?.[1] ?? null;
}
function translateApiError(path, detail) {
    const normalized = detail.trim();
    if (path.includes('/transcriptions/upload') || path.includes('/transcriptions/batch-upload')) {
        if (normalized.startsWith('Unsupported media format:')) {
            const fileMatch = normalized.match(/^Unsupported media format:\s*(.+?)(?:\. Supported formats:|$)/);
            const supportedMatch = normalized.match(/Supported formats:\s*(.+)$/);
            return supportedMatch
                ? `不支持的上传格式：${fileMatch?.[1] ?? '该文件'}。可上传格式：${supportedMatch[1]}`
                : `不支持的上传格式：${fileMatch?.[1] ?? '该文件'}。`;
        }
        if (normalized.startsWith('Uploaded file is empty:')) {
            return normalized.replace('Uploaded file is empty:', '上传失败，文件为空，请确认文件已正确导出：').trim();
        }
        if (normalized.startsWith('File exceeds configured upload limit:')) {
            return normalized.replace('File exceeds configured upload limit:', '上传失败，文件超过系统上传大小限制，请压缩或更换文件：').trim();
        }
        const invalidFileMatch = normalized.match(/^Invalid file\s+(.+?):\s+(.+)$/);
        if (invalidFileMatch) {
            const [, filename, reason] = invalidFileMatch;
            if (reason.startsWith('MIME type does not match audio file')) {
                const mime = reason.split(':').slice(1).join(':').trim();
                return mime
                    ? `文件校验失败：${filename}，文件后缀看起来是音频，但浏览器识别到的类型是 ${mime}。`
                    : `文件校验失败：${filename}，文件后缀看起来是音频，但实际类型不匹配。`;
            }
            if (reason.startsWith('MIME type does not match video file')) {
                const mime = reason.split(':').slice(1).join(':').trim();
                return mime
                    ? `文件校验失败：${filename}，文件后缀看起来是视频，但浏览器识别到的类型是 ${mime}。`
                    : `文件校验失败：${filename}，文件后缀看起来是视频，但实际类型不匹配。`;
            }
            if (reason.startsWith('MIME type does not match subtitle file')) {
                const mime = reason.split(':').slice(1).join(':').trim();
                return mime
                    ? `文件校验失败：${filename}，文件后缀看起来是字幕，但浏览器识别到的类型是 ${mime}。`
                    : `文件校验失败：${filename}，文件后缀看起来是字幕，但实际类型不匹配。`;
            }
            if (reason === 'File content does not match the selected extension') {
                return `文件校验失败：${filename}，文件扩展名与实际内容不一致，请确认没有手动改过后缀名。`;
            }
            if (reason === 'Subtitle file does not contain readable text') {
                return `文件校验失败：${filename}，字幕文件里没有识别到可导入的正文内容。`;
            }
            return `文件校验失败：${filename}，${reason}`;
        }
        if (normalized.startsWith('No readable subtitle text found:')) {
            return normalized.replace('No readable subtitle text found:', '字幕文件中未找到可导入文本，请检查文件内容：').trim();
        }
        if (normalized === 'No files provided') {
            return '未选择任何文件。';
        }
    }
    if (path.includes('/speech-generations/generate')) {
        if (normalized === 'Uploaded document is empty') {
            return '上传失败，文档内容为空，请重新选择文档。';
        }
        if (normalized === 'No readable text found in document') {
            return '文档中未识别到可用于生成语音的正文内容。';
        }
        if (normalized === 'Unsupported document format') {
            return '当前文档格式不支持生成语音，请上传 txt、md 或 docx 文件。';
        }
        if (normalized === 'Please provide text or upload a document') {
            return '请输入文本或上传文档后再生成语音。';
        }
        if (normalized === 'Unsupported speech output format') {
            return '不支持当前选择的语音导出格式。';
        }
        if (normalized.startsWith('Speech synthesis failed:')) {
            return '语音生成失败，语音引擎暂时无法处理当前内容，请稍后重试。';
        }
    }
    if (path.includes('/speech-generations')) {
        if (normalized === 'Generated audio file not found') {
            return '生成的音频文件不存在，可能已被删除，请重新生成。';
        }
        if (normalized === 'Generated speech record not found') {
            return '语音记录不存在，可能已被删除。';
        }
        if (normalized === 'Not allowed') {
            return '你没有权限执行这个操作。';
        }
        if (normalized === 'Audio fetch failed') {
            return '获取音频失败，请稍后重试。';
        }
        if (normalized === 'Audio download failed') {
            return '下载音频失败，请稍后重试。';
        }
    }
    if (normalized === 'Request failed') {
        return '请求失败，请稍后重试。';
    }
    return normalized;
}
