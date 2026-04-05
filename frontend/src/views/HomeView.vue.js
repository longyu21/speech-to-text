import { onMounted, onUnmounted, ref, watch } from 'vue';
import { batchUploadAudio, deleteUpload, downloadTranscript, listUploads, retryUpload, uploadAudio } from '@/api/client';
import TranscriptPanel from '@/components/TranscriptPanel.vue';
import UploadPanel from '@/components/UploadPanel.vue';
import { useAuthStore } from '@/stores/auth';
const authStore = useAuthStore();
const records = ref([]);
const transcriptText = ref('');
const languageLabel = ref('待识别');
const notice = ref('');
const errorMessage = ref('');
const loading = ref(false);
const MESSAGE_TIMEOUT_MS = 4000;
let pollTimer = null;
let noticeTimer = null;
let errorTimer = null;
const recordStatusMap = new Map();
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
function syncStatusNotifications(nextRecords) {
    let nextNotice = '';
    let nextError = '';
    nextRecords.forEach((record) => {
        const previousStatus = recordStatusMap.get(record.id);
        const currentStatus = record.status;
        recordStatusMap.set(record.id, currentStatus);
        if (!previousStatus || previousStatus === currentStatus) {
            return;
        }
        if (currentStatus === 'completed') {
            nextNotice = `${describeSource(record)} 转写完成`;
            return;
        }
        if (currentStatus === 'failed') {
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
async function loadRecords() {
    if (!authStore.token) {
        return;
    }
    const nextRecords = await listUploads(authStore.token, 'local');
    syncStatusNotifications(nextRecords);
    records.value = nextRecords;
    const latest = records.value[0];
    if (latest?.transcript_text) {
        transcriptText.value = latest.transcript_text;
        languageLabel.value = latest.detected_language || 'Unknown';
    }
    const hasPendingTasks = records.value.some((record) => record.status === 'queued' || record.status === 'processing');
    if (hasPendingTasks && pollTimer === null) {
        pollTimer = window.setInterval(() => {
            loadRecords().catch(() => undefined);
        }, 3000);
    }
    if (!hasPendingTasks && pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
}
function selectRecord(record) {
    transcriptText.value = record.transcript_text || '';
    languageLabel.value = record.detected_language || 'Unknown';
    if (record.status === 'completed') {
        notice.value = `${describeSource(record)} 转写完成`;
        errorMessage.value = '';
    }
    else if (record.status === 'failed') {
        errorMessage.value = record.error_message
            ? `${describeSource(record)} 转写失败：${record.error_message}`
            : `${describeSource(record)} 转写失败`;
        notice.value = '';
    }
}
async function handleUpload(files) {
    if (!authStore.token) {
        return;
    }
    notice.value = '';
    errorMessage.value = '';
    loading.value = true;
    try {
        if (files.length === 1) {
            const result = await uploadAudio(files[0], authStore.token);
            transcriptText.value = result.text;
            languageLabel.value = result.language_label;
            notice.value = result.upload.status === 'completed'
                ? '文件已导入，文本已生成'
                : '文件已入队，系统将自动开始转写';
            if (result.upload.status === 'failed') {
                errorMessage.value = result.upload.error_message || '转写失败';
                notice.value = '';
            }
        }
        else {
            const result = await batchUploadAudio(files, authStore.token);
            notice.value = `批量任务已入队，共 ${result.uploads.length} 个文件，批次号 ${result.batch_id}`;
        }
        await loadRecords();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '上传失败';
    }
    finally {
        loading.value = false;
    }
}
async function handleDownload(uploadId) {
    if (!authStore.token) {
        return;
    }
    errorMessage.value = '';
    try {
        const { blob, filename } = await downloadTranscript(uploadId, authStore.token);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename || `transcript-${uploadId}.docx`;
        anchor.click();
        URL.revokeObjectURL(url);
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '下载失败';
    }
}
async function handleRetry(uploadId) {
    if (!authStore.token) {
        return;
    }
    try {
        await retryUpload(uploadId, authStore.token);
        notice.value = '任务已重新入队';
        await loadRecords();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '重试失败';
    }
}
async function handleRemove(uploadId) {
    if (!authStore.token) {
        return;
    }
    try {
        await deleteUpload(uploadId, authStore.token);
        notice.value = '文件记录已删除';
        await loadRecords();
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '删除失败';
    }
}
onMounted(() => {
    loadRecords().catch((error) => {
        errorMessage.value = error instanceof Error ? error.message : '加载失败';
    });
});
watch(notice, () => {
    scheduleMessageClear('notice');
});
watch(errorMessage, () => {
    scheduleMessageClear('error');
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
    ...{ class: "page-grid" },
});
/** @type {[typeof UploadPanel, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(UploadPanel, new UploadPanel({
    ...{ 'onUpload': {} },
}));
const __VLS_1 = __VLS_0({
    ...{ 'onUpload': {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
let __VLS_3;
let __VLS_4;
let __VLS_5;
const __VLS_6 = {
    onUpload: (__VLS_ctx.handleUpload)
};
var __VLS_2;
if (__VLS_ctx.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "notice" },
    });
}
const __VLS_7 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_8 = __VLS_asFunctionalComponent(__VLS_7, new __VLS_7({
    name: "message-fade",
}));
const __VLS_9 = __VLS_8({
    name: "message-fade",
}, ...__VLS_functionalComponentArgsRest(__VLS_8));
__VLS_10.slots.default;
if (__VLS_ctx.notice) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "success-box" },
    });
    (__VLS_ctx.notice);
}
var __VLS_10;
const __VLS_11 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({
    name: "message-fade",
}));
const __VLS_13 = __VLS_12({
    name: "message-fade",
}, ...__VLS_functionalComponentArgsRest(__VLS_12));
__VLS_14.slots.default;
if (__VLS_ctx.errorMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "error-box" },
    });
    (__VLS_ctx.errorMessage);
}
var __VLS_14;
/** @type {[typeof TranscriptPanel, ]} */ ;
// @ts-ignore
const __VLS_15 = __VLS_asFunctionalComponent(TranscriptPanel, new TranscriptPanel({
    ...{ 'onDownload': {} },
    ...{ 'onRetry': {} },
    ...{ 'onRemove': {} },
    ...{ 'onSelect': {} },
    languageLabel: (__VLS_ctx.languageLabel),
    records: (__VLS_ctx.records),
    transcriptText: (__VLS_ctx.transcriptText),
}));
const __VLS_16 = __VLS_15({
    ...{ 'onDownload': {} },
    ...{ 'onRetry': {} },
    ...{ 'onRemove': {} },
    ...{ 'onSelect': {} },
    languageLabel: (__VLS_ctx.languageLabel),
    records: (__VLS_ctx.records),
    transcriptText: (__VLS_ctx.transcriptText),
}, ...__VLS_functionalComponentArgsRest(__VLS_15));
let __VLS_18;
let __VLS_19;
let __VLS_20;
const __VLS_21 = {
    onDownload: (__VLS_ctx.handleDownload)
};
const __VLS_22 = {
    onRetry: (__VLS_ctx.handleRetry)
};
const __VLS_23 = {
    onRemove: (__VLS_ctx.handleRemove)
};
const __VLS_24 = {
    onSelect: (__VLS_ctx.selectRecord)
};
var __VLS_17;
/** @type {__VLS_StyleScopedClasses['page-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['success-box']} */ ;
/** @type {__VLS_StyleScopedClasses['error-box']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            TranscriptPanel: TranscriptPanel,
            UploadPanel: UploadPanel,
            records: records,
            transcriptText: transcriptText,
            languageLabel: languageLabel,
            notice: notice,
            errorMessage: errorMessage,
            loading: loading,
            selectRecord: selectRecord,
            handleUpload: handleUpload,
            handleDownload: handleDownload,
            handleRetry: handleRetry,
            handleRemove: handleRemove,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
