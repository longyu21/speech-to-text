import { onMounted, onUnmounted, ref } from 'vue';
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
let pollTimer = null;
async function loadRecords() {
    if (!authStore.token) {
        return;
    }
    records.value = await listUploads(authStore.token);
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
onUnmounted(() => {
    if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
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
if (__VLS_ctx.notice) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "success-box" },
    });
    (__VLS_ctx.notice);
}
if (__VLS_ctx.errorMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "error-box" },
    });
    (__VLS_ctx.errorMessage);
}
/** @type {[typeof TranscriptPanel, ]} */ ;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent(TranscriptPanel, new TranscriptPanel({
    ...{ 'onDownload': {} },
    ...{ 'onRetry': {} },
    ...{ 'onRemove': {} },
    ...{ 'onSelect': {} },
    languageLabel: (__VLS_ctx.languageLabel),
    records: (__VLS_ctx.records),
    transcriptText: (__VLS_ctx.transcriptText),
}));
const __VLS_8 = __VLS_7({
    ...{ 'onDownload': {} },
    ...{ 'onRetry': {} },
    ...{ 'onRemove': {} },
    ...{ 'onSelect': {} },
    languageLabel: (__VLS_ctx.languageLabel),
    records: (__VLS_ctx.records),
    transcriptText: (__VLS_ctx.transcriptText),
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
let __VLS_10;
let __VLS_11;
let __VLS_12;
const __VLS_13 = {
    onDownload: (__VLS_ctx.handleDownload)
};
const __VLS_14 = {
    onRetry: (__VLS_ctx.handleRetry)
};
const __VLS_15 = {
    onRemove: (__VLS_ctx.handleRemove)
};
const __VLS_16 = {
    onSelect: (__VLS_ctx.selectRecord)
};
var __VLS_9;
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
