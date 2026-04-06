import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { buildUploadMediaUrl, createUrlTranscription, deleteUpload, downloadTranscript, downloadTranscriptText, listUploads, pauseTranscriptTranslation, retryUpload, startTranscriptTranslation, updateTranscriptCorrection } from '@/api/client';
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
const retryingRecordId = ref(null);
const deletingRecordId = ref(null);
const currentTime = ref(0);
const activeSegmentIndex = ref(-1);
const mediaElement = ref(null);
const segmentListElement = ref(null);
const transcriptEditMode = ref(false);
const savingTranscript = ref(false);
const transcriptDraftText = ref('');
const transcriptDraftSegments = ref([]);
const MESSAGE_TIMEOUT_MS = 4000;
const recordStatusMap = new Map();
const segmentElementMap = new Map();
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
    paused: '已暂停',
    resolving_url: '解析链接',
    resolving_embedded_media: '解析内嵌媒体',
    downloading_media: '下载媒体',
    extracting_audio: '提取音轨',
    transcribing: '正在识别语音',
    refining_japanese: '日语精修中',
    completed: '已完成',
    failed: '处理失败',
};
const urlRecords = computed(() => records.value.filter((record) => Boolean(record.source_url)));
const selectedRecord = computed(() => urlRecords.value.find((record) => record.id === selectedId.value) ?? urlRecords.value[0] ?? null);
const selectedSegments = computed(() => selectedRecord.value?.transcript_segments ?? []);
const selectedHasTranscript = computed(() => Boolean(selectedRecord.value?.transcript_text?.trim()) || selectedSegments.value.length > 0);
const selectedTranslationJob = computed(() => {
    if (!selectedRecord.value || !translationEnabled.value) {
        return null;
    }
    return selectedRecord.value.translation_jobs?.[translationLanguage.value] ?? null;
});
const selectedTranslation = computed(() => {
    const currentJob = selectedTranslationJob.value;
    if (!currentJob) {
        return null;
    }
    if (!currentJob.text?.trim() && !currentJob.segments.length) {
        return null;
    }
    return {
        target_language: currentJob.target_language,
        target_language_label: currentJob.target_language_label,
        text: currentJob.text ?? '',
        segments: currentJob.segments ?? [],
    };
});
const translationLoading = computed(() => ['queued', 'processing'].includes(selectedTranslationJob.value?.status ?? ''));
const translatedSegments = computed(() => selectedTranslation.value?.segments ?? []);
const translatedTranscriptText = computed(() => selectedTranslation.value?.text ?? '');
const canTranslateSelected = computed(() => selectedRecord.value?.status === 'completed' && selectedHasTranscript.value);
const showTranslationSkeleton = computed(() => {
    if (!translationEnabled.value || !translationLoading.value || !canTranslateSelected.value) {
        return false;
    }
    return !translatedSegments.value.length && !translatedTranscriptText.value.trim();
});
const translationStatusMessage = computed(() => {
    if (!translationEnabled.value || !canTranslateSelected.value) {
        return '';
    }
    if (translationLoading.value && selectedTranslationJob.value) {
        const translatedCount = selectedTranslationJob.value.translated_segment_count || 0;
        const totalCount = selectedTranslationJob.value.total_segment_count || 0;
        const countMessage = totalCount > 0 ? `，已完成 ${translatedCount}/${totalCount} 段` : '';
        return `翻译进行中，当前进度 ${selectedTranslationJob.value.progress_percent}%${countMessage}。`;
    }
    if (selectedTranslationJob.value?.status === 'paused') {
        return `翻译已暂停，当前进度 ${selectedTranslationJob.value.progress_percent}%，可继续处理。`;
    }
    if (selectedTranslationJob.value?.status === 'failed') {
        return '翻译失败，可重新继续处理。';
    }
    if (selectedTranslation.value && selectedTranslationJob.value?.status === 'completed') {
        return `当前显示 ${selectedTranslation.value.target_language_label} 翻译。`;
    }
    return '';
});
const selectedTranslationError = computed(() => {
    if (!translationEnabled.value) {
        return '';
    }
    if (selectedTranslationJob.value?.status !== 'failed') {
        return '';
    }
    return selectedTranslationJob.value.error_message || '翻译失败，请稍后继续处理。';
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
    if (selectedRecord.value.status === 'paused') {
        return hasPartialTranscript(selectedRecord.value)
            ? '该 URL 任务已暂停，点击“继续重试”后会从上次已完成片段后继续处理。'
            : '该 URL 任务在服务重启后已暂停，点击“重试”后才会继续处理。';
    }
    if (selectedRecord.value.status === 'failed' && hasPartialTranscript(selectedRecord.value)) {
        return '本次处理已保留失败前的文本片段，点击“继续重试”可从上次失败位置后继续。';
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
    return ['extracting_audio', 'transcribing', 'paused', 'completed', 'failed'].includes(selectedRecord.value.processing_stage || '');
});
const selectedProgressPercent = computed(() => normalizeProgressPercent(selectedRecord.value?.progress_percent ?? 0, selectedRecord.value?.status ?? 'queued'));
const editingTranslation = computed(() => transcriptEditMode.value && translationEnabled.value);
const canEditSelectedText = computed(() => {
    if (!selectedRecord.value || selectedRecord.value.status !== 'completed') {
        return false;
    }
    if (translationEnabled.value) {
        return selectedTranslationJob.value?.status === 'completed' && Boolean(selectedTranslation.value);
    }
    return selectedHasTranscript.value;
});
const transcriptEditTitle = computed(() => editingTranslation.value ? `${translationLanguage.value.toUpperCase()} 翻译修正` : '原文修正');
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
function hasPartialTranscript(record) {
    return Boolean(record.transcript_segments?.length || record.transcript_text?.trim());
}
function canRetryRecord(record) {
    return ['failed', 'paused', 'completed'].includes(record.status);
}
function getRetryLabel(record) {
    if (record.source_url && ['failed', 'paused'].includes(record.status) && hasPartialTranscript(record)) {
        return '继续重试';
    }
    return '重试';
}
function hasRunningTranslationJob(record) {
    return Object.values(record.translation_jobs ?? {}).some((job) => Boolean(job) && ['queued', 'processing'].includes(job.status));
}
function shouldShowTranslationAction() {
    if (!translationEnabled.value || !selectedRecord.value || !canTranslateSelected.value) {
        return false;
    }
    return selectedTranslationJob.value?.status !== 'completed';
}
function getTranslationActionLabel() {
    const status = selectedTranslationJob.value?.status ?? 'idle';
    if (status === 'queued' || status === 'processing') {
        return '暂停翻译';
    }
    if (status === 'paused') {
        return '继续翻译';
    }
    if (status === 'failed') {
        return '重新继续翻译';
    }
    return '开始翻译';
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
        if (record.status === 'paused') {
            nextNotice = `${describeSource(record)} 已暂停，点击重试后继续处理`;
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
async function handleTranslationAction() {
    if (!authStore.token || !selectedRecord.value || !translationEnabled.value || !canTranslateSelected.value) {
        return;
    }
    const activeJobStatus = selectedTranslationJob.value?.status ?? 'idle';
    const isPauseAction = activeJobStatus === 'queued' || activeJobStatus === 'processing';
    errorMessage.value = '';
    try {
        const updatedRecord = isPauseAction
            ? await pauseTranscriptTranslation(selectedRecord.value.id, translationLanguage.value, authStore.token)
            : await startTranscriptTranslation(selectedRecord.value.id, translationLanguage.value, authStore.token);
        replaceRecordInState(updatedRecord);
        notice.value = isPauseAction
            ? '翻译已暂停，可稍后继续。'
            : activeJobStatus === 'paused'
                ? '翻译已继续处理。'
                : '翻译任务已开始。';
        await loadRecords();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '翻译处理失败';
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
    const hasPendingTasks = urlRecords.value.some((record) => record.status === 'queued' || record.status === 'processing' || hasRunningTranslationJob(record));
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
            : 'URL 媒体已解析完成，任务已入队转写。若服务重启，任务会自动暂停，需手动点重试继续。';
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
    if (translationEnabled.value && selectedTranslationJob.value?.status !== 'completed') {
        errorMessage.value = '当前翻译尚未完成，请先继续处理或关闭翻译后再下载。';
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
async function handleRetry(recordId) {
    if (!authStore.token || retryingRecordId.value !== null) {
        return;
    }
    const targetRecord = urlRecords.value.find((record) => record.id === recordId);
    if (!targetRecord) {
        return;
    }
    retryingRecordId.value = recordId;
    errorMessage.value = '';
    try {
        await retryUpload(recordId, authStore.token);
        notice.value = targetRecord.source_url && ['failed', 'paused'].includes(targetRecord.status) && hasPartialTranscript(targetRecord)
            ? `${describeSource(targetRecord)} 已继续入队，会从上次失败位置后面继续处理`
            : `${describeSource(targetRecord)} 已重新入队`;
        await loadRecords();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : 'URL 任务重试失败';
    }
    finally {
        retryingRecordId.value = null;
    }
}
function handleSelect(record) {
    cancelTranscriptEdit();
    selectedId.value = record.id;
}
function replaceRecordInState(updatedRecord) {
    records.value = records.value.map((record) => record.id === updatedRecord.id ? updatedRecord : record);
}
function beginTranscriptEdit() {
    if (!selectedRecord.value) {
        return;
    }
    transcriptEditMode.value = true;
    if (translationEnabled.value && selectedTranslation.value) {
        transcriptDraftSegments.value = (selectedTranslation.value.segments ?? []).map((segment) => ({ ...segment }));
        transcriptDraftText.value = selectedTranslation.value.text ?? '';
        return;
    }
    transcriptDraftSegments.value = (selectedRecord.value.transcript_segments ?? []).map((segment) => ({ ...segment }));
    transcriptDraftText.value = selectedRecord.value.transcript_text ?? '';
}
function cancelTranscriptEdit() {
    transcriptEditMode.value = false;
    transcriptDraftText.value = '';
    transcriptDraftSegments.value = [];
}
async function handleStartTranscriptEdit() {
    if (!selectedRecord.value) {
        return;
    }
    errorMessage.value = '';
    if (translationEnabled.value && selectedTranslationJob.value?.status !== 'completed') {
        errorMessage.value = '翻译完成后才可以修正翻译文本。';
        return;
    }
    beginTranscriptEdit();
}
async function handleSaveTranscriptEdit() {
    if (!authStore.token || !selectedRecord.value || savingTranscript.value) {
        return;
    }
    const payload = editingTranslation.value
        ? { target_language: translationLanguage.value }
        : {};
    if (transcriptDraftSegments.value.length) {
        payload.segments = transcriptDraftSegments.value.map((segment) => ({
            start: segment.start,
            end: segment.end,
            text: segment.text,
        }));
    }
    else {
        payload.text = transcriptDraftText.value;
    }
    savingTranscript.value = true;
    errorMessage.value = '';
    try {
        const updatedRecord = await updateTranscriptCorrection(selectedRecord.value.id, payload, authStore.token);
        replaceRecordInState(updatedRecord);
        notice.value = editingTranslation.value ? '翻译文本已保存修正。' : '原文已保存修正。';
        cancelTranscriptEdit();
        await nextTick();
        setMediaElementState();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '文本修正保存失败';
    }
    finally {
        savingTranscript.value = false;
    }
}
function handleSegmentCardClick(segment) {
    if (transcriptEditMode.value) {
        return;
    }
    seekToSegment(segment);
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
function createSegmentElementRef(index) {
    return (element) => {
        setSegmentElement(index, element);
    };
}
function captureSegmentListElement(element) {
    const resolvedElement = element instanceof HTMLElement
        ? element
        : element && '$el' in element && element.$el instanceof HTMLElement
            ? element.$el
            : null;
    segmentListElement.value = resolvedElement;
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
watch(selectedRecord, async (record, previousRecord) => {
    if (!record) {
        cancelTranscriptEdit();
        activeSegmentIndex.value = -1;
        currentTime.value = 0;
        segmentElementMap.clear();
        return;
    }
    const selectedRecordChanged = record.id !== previousRecord?.id;
    if (selectedRecordChanged) {
        cancelTranscriptEdit();
        currentTime.value = 0;
        activeSegmentIndex.value = -1;
    }
    selectedId.value = record.id;
    await nextTick();
    setMediaElementState();
});
watch([translationEnabled, translationLanguage], async ([enabled]) => {
    cancelTranscriptEdit();
    if (!enabled || !selectedRecord.value || !canTranslateSelected.value) {
        return;
    }
    await nextTick();
    setMediaElementState();
});
watch(activeSegmentIndex, async (index) => {
    if (index < 0) {
        return;
    }
    await nextTick();
    const segmentElement = segmentElementMap.get(index);
    const listElement = segmentListElement.value;
    if (!segmentElement || !listElement) {
        return;
    }
    const targetTop = Math.max(0, segmentElement.offsetTop - listElement.offsetTop - 8);
    listElement.scrollTo({ top: targetTop, behavior: 'smooth' });
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
        key: (`video-${__VLS_ctx.selectedRecord.id}`),
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
        key: (`audio-${__VLS_ctx.selectedRecord.id}`),
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
    disabled: (!__VLS_ctx.canTranslateSelected),
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
if (__VLS_ctx.shouldShowTranslationAction()) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleTranslationAction) },
        ...{ class: "ghost-button" },
        type: "button",
    });
    (__VLS_ctx.getTranslationActionLabel());
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
if (__VLS_ctx.selectedRecord && __VLS_ctx.canRetryRecord(__VLS_ctx.selectedRecord)) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.selectedRecord && __VLS_ctx.canRetryRecord(__VLS_ctx.selectedRecord)))
                    return;
                __VLS_ctx.handleRetry(__VLS_ctx.selectedRecord.id);
            } },
        ...{ class: "ghost-button" },
        type: "button",
        disabled: (__VLS_ctx.retryingRecordId === __VLS_ctx.selectedRecord.id),
    });
    (__VLS_ctx.retryingRecordId === __VLS_ctx.selectedRecord.id ? '提交中...' : __VLS_ctx.getRetryLabel(__VLS_ctx.selectedRecord));
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
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "player-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "table-actions" },
});
if (!__VLS_ctx.transcriptEditMode) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleStartTranscriptEdit) },
        ...{ class: "secondary-button" },
        type: "button",
        disabled: (!__VLS_ctx.canEditSelectedText || __VLS_ctx.translationLoading),
    });
    (__VLS_ctx.translationEnabled ? '翻译文本' : '原文');
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "status-badge status-badge--loading" },
    });
    (__VLS_ctx.transcriptEditTitle);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleSaveTranscriptEdit) },
        ...{ class: "primary-button" },
        type: "button",
        disabled: (__VLS_ctx.savingTranscript),
    });
    (__VLS_ctx.savingTranscript ? '保存中...' : '保存修正');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.cancelTranscriptEdit) },
        ...{ class: "ghost-button" },
        type: "button",
        disabled: (__VLS_ctx.savingTranscript),
    });
}
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
if (__VLS_ctx.selectedTranslationError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "error-box" },
    });
    (__VLS_ctx.selectedTranslationError);
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
        ref: (__VLS_ctx.captureSegmentListElement),
        ...{ class: "segment-list" },
    });
    for (const [segment, index] of __VLS_getVForSourceType((__VLS_ctx.selectedSegments))) {
        const __VLS_8 = ((__VLS_ctx.transcriptEditMode ? 'div' : 'button'));
        // @ts-ignore
        const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
            ...{ 'onClick': {} },
            key: (`${__VLS_ctx.selectedRecord?.id}-${index}`),
            ref: (__VLS_ctx.createSegmentElementRef(index)),
            ...{ class: "segment-card" },
            ...{ class: ({ active: index === __VLS_ctx.activeSegmentIndex }) },
            type: (__VLS_ctx.transcriptEditMode ? undefined : 'button'),
        }));
        const __VLS_10 = __VLS_9({
            ...{ 'onClick': {} },
            key: (`${__VLS_ctx.selectedRecord?.id}-${index}`),
            ref: (__VLS_ctx.createSegmentElementRef(index)),
            ...{ class: "segment-card" },
            ...{ class: ({ active: index === __VLS_ctx.activeSegmentIndex }) },
            type: (__VLS_ctx.transcriptEditMode ? undefined : 'button'),
        }, ...__VLS_functionalComponentArgsRest(__VLS_9));
        let __VLS_12;
        let __VLS_13;
        let __VLS_14;
        const __VLS_15 = {
            onClick: (...[$event]) => {
                if (!(__VLS_ctx.selectedSegments.length))
                    return;
                __VLS_ctx.handleSegmentCardClick(segment);
            }
        };
        __VLS_11.slots.default;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "segment-time" },
        });
        (__VLS_ctx.formatTime(segment.start));
        (__VLS_ctx.formatTime(segment.end));
        if (__VLS_ctx.transcriptEditMode && __VLS_ctx.transcriptDraftSegments[index]) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.textarea, __VLS_intrinsicElements.textarea)({
                ...{ onClick: () => { } },
                value: (__VLS_ctx.transcriptDraftSegments[index].text),
                ...{ class: "segment-editor" },
                rows: "2",
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "segment-text" },
            });
            (segment.text);
        }
        if (__VLS_ctx.transcriptEditMode && __VLS_ctx.translationEnabled) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "segment-text-secondary" },
            });
            (segment.text);
        }
        else if (__VLS_ctx.translationEnabled && __VLS_ctx.translatedSegments[index]?.text && __VLS_ctx.translatedSegments[index].text !== segment.text) {
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
        var __VLS_11;
    }
}
else if (__VLS_ctx.selectedRecord?.transcript_text) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "plain-transcript-stack" },
    });
    if (__VLS_ctx.transcriptEditMode) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.textarea, __VLS_intrinsicElements.textarea)({
            value: (__VLS_ctx.transcriptDraftText),
            ...{ class: "plain-transcript-box transcript-editor" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "plain-transcript-box" },
        });
        (__VLS_ctx.translationEnabled && __VLS_ctx.translatedTranscriptText ? __VLS_ctx.translatedTranscriptText : __VLS_ctx.selectedRecord.transcript_text);
    }
    if (__VLS_ctx.transcriptEditMode && __VLS_ctx.translationEnabled) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "plain-transcript-box plain-transcript-box--secondary" },
        });
        (__VLS_ctx.selectedRecord.transcript_text);
    }
    else if (__VLS_ctx.translationEnabled && __VLS_ctx.translatedTranscriptText && __VLS_ctx.translatedTranscriptText !== __VLS_ctx.selectedRecord.transcript_text) {
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
        if (__VLS_ctx.canRetryRecord(record)) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.urlRecords.length))
                            return;
                        if (!(__VLS_ctx.canRetryRecord(record)))
                            return;
                        __VLS_ctx.handleRetry(record.id);
                    } },
                ...{ class: "ghost-button" },
                type: "button",
                disabled: (__VLS_ctx.retryingRecordId === record.id),
            });
            (__VLS_ctx.retryingRecordId === record.id ? '提交中...' : __VLS_ctx.getRetryLabel(record));
        }
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
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge--loading']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['sync-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['player-header']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['table-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge--loading']} */ ;
/** @type {__VLS_StyleScopedClasses['primary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['error-box']} */ ;
/** @type {__VLS_StyleScopedClasses['error-box']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-track']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-fill']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-list']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-card']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-time']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-text']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-text-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-text-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['segment-text-skeleton']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-stack']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box']} */ ;
/** @type {__VLS_StyleScopedClasses['transcript-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box']} */ ;
/** @type {__VLS_StyleScopedClasses['plain-transcript-box--secondary']} */ ;
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
            retryingRecordId: retryingRecordId,
            deletingRecordId: deletingRecordId,
            currentTime: currentTime,
            activeSegmentIndex: activeSegmentIndex,
            transcriptEditMode: transcriptEditMode,
            savingTranscript: savingTranscript,
            transcriptDraftText: transcriptDraftText,
            transcriptDraftSegments: transcriptDraftSegments,
            translationOptions: translationOptions,
            downloadFormatOptions: downloadFormatOptions,
            urlRecords: urlRecords,
            selectedRecord: selectedRecord,
            selectedSegments: selectedSegments,
            translationLoading: translationLoading,
            translatedSegments: translatedSegments,
            translatedTranscriptText: translatedTranscriptText,
            canTranslateSelected: canTranslateSelected,
            showTranslationSkeleton: showTranslationSkeleton,
            translationStatusMessage: translationStatusMessage,
            selectedTranslationError: selectedTranslationError,
            selectedPersistentError: selectedPersistentError,
            selectedPersistentNotice: selectedPersistentNotice,
            mediaUrl: mediaUrl,
            isVideoSource: isVideoSource,
            canPreviewSelectedMedia: canPreviewSelectedMedia,
            selectedProgressPercent: selectedProgressPercent,
            canEditSelectedText: canEditSelectedText,
            transcriptEditTitle: transcriptEditTitle,
            normalizeProgressPercent: normalizeProgressPercent,
            formatProgressStage: formatProgressStage,
            canRetryRecord: canRetryRecord,
            getRetryLabel: getRetryLabel,
            shouldShowTranslationAction: shouldShowTranslationAction,
            getTranslationActionLabel: getTranslationActionLabel,
            handleTranslationAction: handleTranslationAction,
            handleSubmit: handleSubmit,
            handleDownloadTranscriptFile: handleDownloadTranscriptFile,
            handleRetry: handleRetry,
            handleSelect: handleSelect,
            cancelTranscriptEdit: cancelTranscriptEdit,
            handleStartTranscriptEdit: handleStartTranscriptEdit,
            handleSaveTranscriptEdit: handleSaveTranscriptEdit,
            handleSegmentCardClick: handleSegmentCardClick,
            handleDelete: handleDelete,
            createSegmentElementRef: createSegmentElementRef,
            captureSegmentListElement: captureSegmentListElement,
            captureMediaElement: captureMediaElement,
            handlePlaybackSync: handlePlaybackSync,
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
