import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { buildUploadMediaUrl, createUrlTranscription, deleteUpload, downloadTranscript, downloadTranscriptText, getTranslatedTranscript, listUploads } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
const authStore = useAuthStore();
const urlInput = ref('');
const records = ref([]);
const selectedId = ref(null);
const loading = ref(false);
const notice = ref('');
const errorMessage = ref('');
const translationEnabled = ref(false);
const translationLanguage = ref('zh');
const downloadFormat = ref('txt');
const translationLoading = ref(false);
const deletingRecordId = ref(null);
const currentTime = ref(0);
const activeSegmentIndex = ref(-1);
const mediaElement = ref(null);
const MESSAGE_TIMEOUT_MS = 4000;
const recordStatusMap = new Map();
const segmentElementMap = new Map();
const translationCache = ref({});
let pollTimer = null;
let noticeTimer = null;
let errorTimer = null;
const translationOptions = [
    { value: 'zh', label: '中文' },
    { value: 'ja', label: '日语' },
    { value: 'en', label: '英语' },
];
const downloadFormatOptions = [
    { value: 'txt', label: 'Text' },
    { value: 'docx', label: 'Word' },
];
const progressLabels = {
    queued: '等待处理',
    resolving_url: '解析链接',
    downloading_media: '下载媒体',
    extracting_audio: '提取音轨',
    transcribing: '正在识别语音',
    completed: '已完成',
    failed: '处理失败',
};
const urlRecords = computed(() => records.value.filter((record) => Boolean(record.source_url)));
const selectedRecord = computed(() => urlRecords.value.find((record) => record.id === selectedId.value) ?? urlRecords.value[0] ?? null);
const selectedSegments = computed(() => selectedRecord.value?.transcript_segments ?? []);
const selectedHasTranscript = computed(() => Boolean(selectedRecord.value?.transcript_text?.trim()) || selectedSegments.value.length > 0);
const selectedTranslation = computed(() => {
    const recordId = selectedRecord.value?.id;
    if (!recordId || !translationEnabled.value) {
        return null;
    }
    return translationCache.value[recordId]?.[translationLanguage.value] ?? null;
});
const translatedSegments = computed(() => selectedTranslation.value?.segments ?? []);
const translatedTranscriptText = computed(() => selectedTranslation.value?.text ?? '');
const canTranslateSelected = computed(() => selectedRecord.value?.status === 'completed' && selectedHasTranscript.value);
const showTranslationSkeleton = computed(() => translationEnabled.value && translationLoading.value && canTranslateSelected.value);
const translationStatusMessage = computed(() => {
    if (!translationEnabled.value || !canTranslateSelected.value) {
        return '';
    }
    if (translationLoading.value) {
        return '正在生成翻译文本，请稍候。';
    }
    if (selectedTranslation.value) {
        return `当前显示 ${selectedTranslation.value.target_language_label} 翻译。`;
    }
    return '';
});
const selectedPersistentError = computed(() => {
    if (!selectedRecord.value) {
        return '';
    }
    if (selectedRecord.value.status === 'failed') {
        return formatRuntimeError(selectedRecord.value.error_message);
    }
    if (selectedRecord.value.status === 'completed' && !selectedHasTranscript.value) {
        return formatRuntimeError(selectedRecord.value.error_message || '未识别到可显示的语音文本，请检查视频是否包含清晰的人声。');
    }
    return '';
});
const selectedPersistentNotice = computed(() => {
    if (!selectedRecord.value) {
        return '';
    }
    if (selectedRecord.value.status === 'queued') {
        return `任务已入队，当前阶段：${formatProgressStage(selectedRecord.value)}。`;
    }
    if (selectedRecord.value.status === 'processing') {
        if (selectedSegments.value.length) {
            return `已生成前 ${selectedSegments.value.length} 段文本，可先播放媒体，剩余内容继续转写中。`;
        }
        return `当前阶段：${formatProgressStage(selectedRecord.value)}，请稍候。`;
    }
    if (selectedRecord.value.status === 'completed' && selectedHasTranscript.value) {
        return '转写已完成，可以播放视频并同步查看文本。';
    }
    return '';
});
const mediaUrl = computed(() => {
    if (!authStore.token || !selectedRecord.value) {
        return '';
    }
    return buildUploadMediaUrl(selectedRecord.value.id, authStore.token);
});
const isVideoSource = computed(() => selectedRecord.value?.source_type === 'video');
const canPreviewSelectedMedia = computed(() => {
    if (!selectedRecord.value || !mediaUrl.value) {
        return false;
    }
    if (selectedRecord.value.source_type !== 'audio' && selectedRecord.value.source_type !== 'video') {
        return false;
    }
    return ['extracting_audio', 'transcribing', 'completed', 'failed'].includes(selectedRecord.value.processing_stage || '');
});
const selectedProgressPercent = computed(() => normalizeProgressPercent(selectedRecord.value?.progress_percent ?? 0, selectedRecord.value?.status ?? 'queued'));
function resetMessageTimer(type) {
    if (type === 'notice' && noticeTimer !== null) {
        window.clearTimeout(noticeTimer);
        noticeTimer = null;
    }
    if (type === 'error' && errorTimer !== null) {
        window.clearTimeout(errorTimer);
        errorTimer = null;
    }
}
function scheduleMessageClear(type) {
    resetMessageTimer(type);
    if (type === 'notice' && notice.value) {
        noticeTimer = window.setTimeout(() => {
            notice.value = '';
            noticeTimer = null;
        }, MESSAGE_TIMEOUT_MS);
    }
    if (type === 'error' && errorMessage.value) {
        errorTimer = window.setTimeout(() => {
            errorMessage.value = '';
            errorTimer = null;
        }, MESSAGE_TIMEOUT_MS);
    }
}
function describeSource(record) {
    return record.original_filename || `记录 ${record.id}`;
}
function formatRuntimeError(message) {
    const normalized = (message || '').trim();
    if (!normalized) {
        return '转写失败，请稍后重试。';
    }
    if (normalized === 'No speech could be recognized from the media') {
        return '未识别到可转写的语音内容，请确认视频里有清晰的人声。';
    }
    return normalized;
}
function normalizeProgressPercent(progressPercent, status) {
    if (status === 'completed' || status === 'failed') {
        return 100;
    }
    return Math.min(100, Math.max(0, Math.round(progressPercent || 0)));
}
function formatProgressStage(record) {
    return progressLabels[record.processing_stage || record.status] || '处理中';
}
function syncStatusNotifications(nextRecords) {
    let nextNotice = '';
    let nextError = '';
    nextRecords.forEach((record) => {
        const previousStatus = recordStatusMap.get(record.id);
        recordStatusMap.set(record.id, record.status);
        if (!previousStatus || previousStatus === record.status) {
            return;
        }
        if (record.status === 'completed') {
            nextNotice = `${describeSource(record)} 转写完成`;
            return;
        }
        if (record.status === 'failed') {
            nextError = record.error_message
                ? `${describeSource(record)} 转写失败：${record.error_message}`
                : `${describeSource(record)} 转写失败`;
        }
    });
    if (nextNotice) {
        notice.value = nextNotice;
        errorMessage.value = '';
    }
    if (nextError) {
        errorMessage.value = nextError;
        notice.value = '';
    }
}
async function ensureTranslation(record) {
    if (!authStore.token || !translationEnabled.value || record.status !== 'completed') {
        return;
    }
    if (translationCache.value[record.id]?.[translationLanguage.value]) {
        return;
    }
    translationLoading.value = true;
    try {
        const translated = await getTranslatedTranscript(record.id, translationLanguage.value, authStore.token);
        translationCache.value = {
            ...translationCache.value,
            [record.id]: {
                ...(translationCache.value[record.id] ?? {}),
                [translationLanguage.value]: translated,
            },
        };
    }
    finally {
        translationLoading.value = false;
    }
}
async function loadRecords() {
    if (!authStore.token) {
        return;
    }
    const nextRecords = await listUploads(authStore.token, 'url');
    syncStatusNotifications(nextRecords);
    records.value = nextRecords;
    if (selectedId.value === null && urlRecords.value[0]) {
        selectedId.value = urlRecords.value[0].id;
    }
    if (selectedId.value !== null && !urlRecords.value.some((record) => record.id === selectedId.value)) {
        selectedId.value = urlRecords.value[0]?.id ?? null;
    }
    const hasPendingTasks = urlRecords.value.some((record) => record.status === 'queued' || record.status === 'processing');
    if (hasPendingTasks && pollTimer === null) {
        pollTimer = window.setInterval(() => {
            loadRecords().catch((error) => {
                errorMessage.value = error instanceof Error ? error.message : 'URL 转写状态刷新失败';
            });
        }, 800);
    }
    if (!hasPendingTasks && pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
}
async function handleSubmit() {
    if (!authStore.token || !urlInput.value.trim()) {
        return;
    }
    loading.value = true;
    notice.value = '';
    errorMessage.value = '';
    try {
        const result = await createUrlTranscription(urlInput.value.trim(), authStore.token);
        selectedId.value = result.upload.id;
        notice.value = result.duplicate_detected
            ? '相同链接已有任务，已为你定位到现有记录。'
            : 'URL 媒体已解析完成，任务已入队转写。';
        urlInput.value = '';
        await loadRecords();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : 'URL 解析失败';
    }
    finally {
        loading.value = false;
    }
}
async function handleDownloadTranscriptFile(uploadId) {
    if (!authStore.token) {
        return;
    }
    errorMessage.value = '';
    try {
        const includeTranslation = translationEnabled.value;
        const targetLanguage = includeTranslation ? translationLanguage.value : undefined;
        const { blob, filename } = downloadFormat.value === 'docx'
            ? await downloadTranscript(uploadId, authStore.token, { includeTranslation, targetLanguage })
            : await downloadTranscriptText(uploadId, authStore.token, { includeTranslation, targetLanguage });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename || `transcript-${uploadId}.${downloadFormat.value}`;
        anchor.click();
        URL.revokeObjectURL(url);
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '文件下载失败';
    }
}
function handleSelect(record) {
    selectedId.value = record.id;
}
async function handleDelete(recordId) {
    if (!authStore.token || deletingRecordId.value !== null) {
        return;
    }
    const targetRecord = urlRecords.value.find((record) => record.id === recordId);
    if (!targetRecord) {
        return;
    }
    if (!window.confirm(`确认删除 ${describeSource(targetRecord)} 吗？`)) {
        return;
    }
    deletingRecordId.value = recordId;
    errorMessage.value = '';
    try {
        await deleteUpload(recordId, authStore.token);
        const nextCache = { ...translationCache.value };
        delete nextCache[recordId];
        translationCache.value = nextCache;
        notice.value = `${describeSource(targetRecord)} 已删除`;
        await loadRecords();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '删除 URL 记录失败';
    }
    finally {
        deletingRecordId.value = null;
    }
}
function setSegmentElement(index, element) {
    const resolvedElement = element instanceof HTMLElement
        ? element
        : element && '$el' in element && element.$el instanceof HTMLElement
            ? element.$el
            : null;
    if (resolvedElement instanceof HTMLElement) {
        segmentElementMap.set(index, resolvedElement);
        return;
    }
    segmentElementMap.delete(index);
}
function resolveActiveSegmentIndex(segments, time) {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (time >= segments[index].start) {
            return index;
        }
    }
    return -1;
}
function setMediaElementState() {
    currentTime.value = mediaElement.value?.currentTime ?? 0;
    activeSegmentIndex.value = findActiveSegmentIndex(selectedSegments.value, currentTime.value);
}
function captureMediaElement(element) {
    const resolvedElement = element instanceof HTMLMediaElement
        ? element
        : element && '$el' in element && element.$el instanceof HTMLMediaElement
            ? element.$el
            : null;
    mediaElement.value = resolvedElement;
}
function handlePlaybackSync() {
    setMediaElementState();
}
function seekToSegment(segment) {
    if (!mediaElement.value) {
        return;
    }
    mediaElement.value.currentTime = Math.max(segment.start, 0);
    setMediaElementState();
    mediaElement.value.play().catch(() => undefined);
}
function findActiveSegmentIndex(segments, time) {
    if (!segments.length) {
        return -1;
    }
    const exactIndex = segments.findIndex((segment) => time >= segment.start && time < segment.end);
    if (exactIndex >= 0) {
        return exactIndex;
    }
    return resolveActiveSegmentIndex(segments, time);
}
function formatTime(seconds) {
    if (!Number.isFinite(seconds)) {
        return '00:00';
    }
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}
watch(notice, () => {
    scheduleMessageClear('notice');
});
watch(errorMessage, () => {
    scheduleMessageClear('error');
});
watch(selectedRecord, async (record) => {
    if (!record) {
        activeSegmentIndex.value = -1;
        currentTime.value = 0;
        segmentElementMap.clear();
        return;
    }
    selectedId.value = record.id;
    currentTime.value = 0;
    activeSegmentIndex.value = -1;
    if (translationEnabled.value && record.status === 'completed' && selectedHasTranscript.value) {
        try {
            await ensureTranslation(record);
        }
        catch (error) {
            errorMessage.value = error instanceof Error ? error.message : '翻译加载失败';
        }
    }
    await nextTick();
    setMediaElementState();
});
watch([translationEnabled, translationLanguage], async ([enabled]) => {
    if (!enabled || !selectedRecord.value || !canTranslateSelected.value) {
        return;
    }
    try {
        await ensureTranslation(selectedRecord.value);
        await nextTick();
        setMediaElementState();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '翻译加载失败';
    }
});
watch(activeSegmentIndex, async (index) => {
    if (index < 0) {
        return;
    }
    await nextTick();
    segmentElementMap.get(index)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
onMounted(() => {
    loadRecords().catch((error) => {
        errorMessage.value = error instanceof Error ? error.message : '加载 URL 记录失败';
    });
});
onUnmounted(() => {
    if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
    resetMessageTimer('notice');
    resetMessageTimer('error');
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-page-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel url-intake-panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "helper-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-intake-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input, __VLS_intrinsicElements.input)({
    ...{ onKeydown: (__VLS_ctx.handleSubmit) },
    type: "url",
    placeholder: "https://example.com/video",
});
(__VLS_ctx.urlInput);
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.handleSubmit) },
    ...{ class: "primary-button" },
    type: "button",
    disabled: (__VLS_ctx.loading || !__VLS_ctx.urlInput.trim()),
});
(__VLS_ctx.loading ? '解析中...' : '开始解析');
const __VLS_0 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    name: "message-fade",
}));
const __VLS_2 = __VLS_1({
    name: "message-fade",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
if (__VLS_ctx.notice) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "success-box" },
    });
    (__VLS_ctx.notice);
}
var __VLS_3;
const __VLS_4 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
    name: "message-fade",
}));
const __VLS_6 = __VLS_5({
    name: "message-fade",
}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
if (__VLS_ctx.errorMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "error-box" },
    });
    (__VLS_ctx.errorMessage);
}
var __VLS_7;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-workspace-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel player-panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "player-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
(__VLS_ctx.selectedRecord?.original_filename || '未选择媒体');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "tag-list" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "status-badge" },
});
(__VLS_ctx.selectedRecord?.status || 'idle');
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "status-badge" },
});
(__VLS_ctx.selectedRecord?.detected_language || '待识别');
if (__VLS_ctx.selectedRecord?.source_url) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
        ...{ class: "source-link" },
        href: (__VLS_ctx.selectedRecord.source_url),
        target: "_blank",
        rel: "noreferrer",
    });
}
if (__VLS_ctx.selectedRecord && __VLS_ctx.canPreviewSelectedMedia && __VLS_ctx.isVideoSource && __VLS_ctx.mediaUrl) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.video)({
        ...{ onTimeupdate: (__VLS_ctx.handlePlaybackSync) },
        ...{ onLoadedmetadata: (__VLS_ctx.handlePlaybackSync) },
        ...{ onSeeked: (__VLS_ctx.handlePlaybackSync) },
        key: (__VLS_ctx.selectedRecord.id),
        ref: (__VLS_ctx.captureMediaElement),
        ...{ class: "media-player" },
        controls: true,
        playsinline: true,
        src: (__VLS_ctx.mediaUrl),
    });
}
else if (__VLS_ctx.selectedRecord && __VLS_ctx.canPreviewSelectedMedia && __VLS_ctx.mediaUrl) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.audio)({
        ...{ onTimeupdate: (__VLS_ctx.handlePlaybackSync) },
        ...{ onLoadedmetadata: (__VLS_ctx.handlePlaybackSync) },
        ...{ onSeeked: (__VLS_ctx.handlePlaybackSync) },
        key: (__VLS_ctx.selectedRecord.id),
        ref: (__VLS_ctx.captureMediaElement),
        ...{ class: "audio-player" },
        controls: true,
        src: (__VLS_ctx.mediaUrl),
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-state" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "toolbar" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "status-badge" },
});
(__VLS_ctx.formatTime(__VLS_ctx.currentTime));
if (__VLS_ctx.selectedRecord) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "status-badge" },
    });
    (__VLS_ctx.formatProgressStage(__VLS_ctx.selectedRecord));
    (__VLS_ctx.selectedProgressPercent);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "toggle-row" },
    for: "translation-toggle",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input, __VLS_intrinsicElements.input)({
    id: "translation-toggle",
    type: "checkbox",
    disabled: (!__VLS_ctx.canTranslateSelected || __VLS_ctx.translationLoading),
});
(__VLS_ctx.translationEnabled);
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.translationLanguage),
    disabled: (!__VLS_ctx.translationEnabled || !__VLS_ctx.canTranslateSelected || __VLS_ctx.translationLoading),
    ...{ style: {} },
});
for (const [option] of __VLS_getVForSourceType((__VLS_ctx.translationOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (option.value),
        value: (option.value),
    });
    (option.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.downloadFormat),
    ...{ style: {} },
});
for (const [option] of __VLS_getVForSourceType((__VLS_ctx.downloadFormatOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (option.value),
        value: (option.value),
    });
    (option.label);
}
if (__VLS_ctx.showTranslationSkeleton) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "status-badge status-badge--loading" },
    });
}
if (__VLS_ctx.selectedRecord) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.selectedRecord))
                    return;
                __VLS_ctx.handleDownloadTranscriptFile(__VLS_ctx.selectedRecord.id);
            } },
        ...{ class: "secondary-button" },
        type: "button",
        disabled: (!__VLS_ctx.selectedRecord.transcript_text),
    });
    (__VLS_ctx.downloadFormat === 'docx' ? 'Word' : 'Text');
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel sync-panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
if (__VLS_ctx.selectedPersistentNotice) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "notice" },
    });
    (__VLS_ctx.selectedPersistentNotice);
}
if (__VLS_ctx.translationStatusMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "notice" },
    });
    (__VLS_ctx.translationStatusMessage);
}
if (__VLS_ctx.selectedPersistentError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "error-box" },
    });
    (__VLS_ctx.selectedPersistentError);
}
if (__VLS_ctx.selectedRecord) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "progress-panel" },
        'aria-label': (`当前任务进度 ${__VLS_ctx.selectedProgressPercent}%`),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "progress-track" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "progress-fill" },
        ...{ style: ({ width: `${__VLS_ctx.selectedProgressPercent}%` }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "progress-meta" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.formatProgressStage(__VLS_ctx.selectedRecord));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.selectedProgressPercent);
}
if (__VLS_ctx.selectedSegments.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "segment-list" },
    });
    for (const [segment, index] of __VLS_getVForSourceType((__VLS_ctx.selectedSegments))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.selectedSegments.length))
                        return;
                    __VLS_ctx.seekToSegment(segment);
                } },
            key: (`${__VLS_ctx.selectedRecord?.id}-${index}`),
            ref: ((element) => __VLS_ctx.setSegmentElement(index, element)),
            ...{ class: "segment-card" },
            ...{ class: ({ active: index === __VLS_ctx.activeSegmentIndex }) },
            type: "button",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "segment-time" },
        });
        (__VLS_ctx.formatTime(segment.start));
        (__VLS_ctx.formatTime(segment.end));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "segment-text" },
        });
        (segment.text);
        if (__VLS_ctx.translationEnabled && __VLS_ctx.translatedSegments[index]?.text && __VLS_ctx.translatedSegments[index].text !== segment.text) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "segment-text-secondary" },
            });
            (__VLS_ctx.translatedSegments[index].text);
        }
        else if (__VLS_ctx.showTranslationSkeleton) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "segment-text-skeleton" },
            });
        }
    }
}
else if (__VLS_ctx.selectedRecord?.transcript_text) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "plain-transcript-stack" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "plain-transcript-box" },
    });
    (__VLS_ctx.selectedRecord.transcript_text);
    if (__VLS_ctx.translationEnabled && __VLS_ctx.translatedTranscriptText && __VLS_ctx.translatedTranscriptText !== __VLS_ctx.selectedRecord.transcript_text) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "plain-transcript-box plain-transcript-box--secondary" },
        });
        (__VLS_ctx.translatedTranscriptText);
    }
    else if (__VLS_ctx.showTranslationSkeleton) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "plain-transcript-box plain-transcript-box--secondary plain-transcript-box--skeleton" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "transcript-skeleton-line" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "transcript-skeleton-line" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "transcript-skeleton-line transcript-skeleton-line--short" },
        });
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-state" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "table-wrap" },
});
if (__VLS_ctx.urlRecords.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.table, __VLS_intrinsicElements.table)({
        ...{ class: "record-list" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
    for (const [record] of __VLS_getVForSourceType((__VLS_ctx.urlRecords))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
            key: (record.id),
            ...{ class: ({ 'selected-row': record.id === __VLS_ctx.selectedRecord?.id }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        (record.original_filename);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "muted" },
        });
        (record.detected_language || '待识别');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        (record.source_type === 'video' ? '视频 URL' : '音频 URL');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "muted clamp-text" },
        });
        (record.source_url);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        (record.status);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "progress-panel progress-panel--compact" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "progress-track" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "progress-fill" },
            ...{ style: ({ width: `${__VLS_ctx.normalizeProgressPercent(record.progress_percent, record.status)}%` }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "muted" },
        });
        (__VLS_ctx.formatProgressStage(record));
        (__VLS_ctx.normalizeProgressPercent(record.progress_percent, record.status));
        if (record.error_message) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "muted" },
            });
            (record.error_message);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "table-actions" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.urlRecords.length))
                        return;
                    __VLS_ctx.handleSelect(record);
                } },
            ...{ class: "secondary-button" },
            type: "button",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.urlRecords.length))
                        return;
                    __VLS_ctx.handleDownloadTranscriptFile(record.id);
                } },
            ...{ class: "ghost-button" },
            type: "button",
            disabled: (!record.transcript_text),
        });
        (__VLS_ctx.downloadFormat === 'docx' ? 'Word' : 'Text');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.urlRecords.length))
                        return;
                    __VLS_ctx.handleDelete(record.id);
                } },
            ...{ class: "ghost-button danger-button" },
            type: "button",
            disabled: (__VLS_ctx.deletingRecordId === record.id),
        });
        (__VLS_ctx.deletingRecordId === record.id ? '删除中...' : '删除');
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-state" },
    });
}
/** @type {__VLS_StyleScopedClasses['url-page-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['url-intake-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
/** @type {__VLS_StyleScopedClasses['url-intake-row']} */ ;
/** @type {__VLS_StyleScopedClasses['primary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['success-box']} */ ;
/** @type {__VLS_StyleScopedClasses['error-box']} */ ;
/** @type {__VLS_StyleScopedClasses['url-workspace-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['player-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['player-header']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-list']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['source-link']} */ ;
/** @type {__VLS_StyleScopedClasses['media-player']} */ ;
/** @type {__VLS_StyleScopedClasses['audio-player']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['toggle-row']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge--loading']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['sync-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['error-box']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-track']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-fill']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-list']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-card']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-time']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-text']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-text-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-text-skeleton']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-stack']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box--secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box--secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box--skeleton']} */ ;
/** @type {__VLS_StyleScopedClasses['transcript-skeleton-line']} */ ;
/** @type {__VLS_StyleScopedClasses['transcript-skeleton-line']} */ ;
/** @type {__VLS_StyleScopedClasses['transcript-skeleton-line']} */ ;
/** @type {__VLS_StyleScopedClasses['transcript-skeleton-line--short']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['table-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['record-list']} */ ;
/** @type {__VLS_StyleScopedClasses['selected-row']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['clamp-text']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-panel--compact']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-track']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-fill']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['table-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['danger-button']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            urlInput: urlInput,
            loading: loading,
            notice: notice,
            errorMessage: errorMessage,
            translationEnabled: translationEnabled,
            translationLanguage: translationLanguage,
            downloadFormat: downloadFormat,
            translationLoading: translationLoading,
            deletingRecordId: deletingRecordId,
            currentTime: currentTime,
            activeSegmentIndex: activeSegmentIndex,
            translationOptions: translationOptions,
            downloadFormatOptions: downloadFormatOptions,
            urlRecords: urlRecords,
            selectedRecord: selectedRecord,
            selectedSegments: selectedSegments,
            translatedSegments: translatedSegments,
            translatedTranscriptText: translatedTranscriptText,
            canTranslateSelected: canTranslateSelected,
            showTranslationSkeleton: showTranslationSkeleton,
            translationStatusMessage: translationStatusMessage,
            selectedPersistentError: selectedPersistentError,
            selectedPersistentNotice: selectedPersistentNotice,
            mediaUrl: mediaUrl,
            isVideoSource: isVideoSource,
            canPreviewSelectedMedia: canPreviewSelectedMedia,
            selectedProgressPercent: selectedProgressPercent,
            normalizeProgressPercent: normalizeProgressPercent,
            formatProgressStage: formatProgressStage,
            handleSubmit: handleSubmit,
            handleDownloadTranscriptFile: handleDownloadTranscriptFile,
            handleSelect: handleSelect,
            handleDelete: handleDelete,
            setSegmentElement: setSegmentElement,
            captureMediaElement: captureMediaElement,
            handlePlaybackSync: handlePlaybackSync,
            seekToSegment: seekToSegment,
            formatTime: formatTime,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
