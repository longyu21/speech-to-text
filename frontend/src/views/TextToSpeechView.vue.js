import { onMounted, onUnmounted, ref } from 'vue';
import { createSpeechGeneration, deleteSpeechGeneration, downloadSpeechAudio, fetchSpeechAudio, listSpeechGenerations } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { formatBackendDateTime } from '@/utils/datetime';
const authStore = useAuthStore();
const textInput = ref('');
const selectedStyle = ref('normal');
const selectedOutputFormat = ref('mp3');
const selectedDocument = ref(null);
const records = ref([]);
const selectedRecord = ref(null);
const audioUrl = ref('');
const languageLabel = ref('待识别');
const notice = ref('');
const errorMessage = ref('');
const loading = ref(false);
const styleOptions = [
    { value: 'normal', label: '正常会话风格' },
    { value: 'male', label: '男声' },
    { value: 'female', label: '女声' },
    { value: 'cute', label: '可爱风格' },
    { value: 'anime', label: '动漫风格' },
    { value: 'news', label: '新闻风格' },
    { value: 'chat', label: '轻松对话风格' },
];
const outputFormatOptions = [
    { value: 'mp3', label: 'MP3' },
    { value: 'wav', label: 'WAV' },
    { value: 'm4a', label: 'M4A' },
];
async function loadRecords() {
    if (!authStore.token) {
        return;
    }
    records.value = await listSpeechGenerations(authStore.token);
    if (!selectedRecord.value && records.value.length) {
        await selectRecord(records.value[0]);
    }
}
function handleDocumentChange(event) {
    const target = event.target;
    selectedDocument.value = target.files?.[0] ?? null;
}
async function handleGenerate() {
    if (!authStore.token) {
        return;
    }
    if (!textInput.value.trim() && !selectedDocument.value) {
        errorMessage.value = '请输入文本或者上传文档';
        return;
    }
    loading.value = true;
    errorMessage.value = '';
    notice.value = '';
    try {
        const response = await createSpeechGeneration({
            text: textInput.value.trim(),
            style: selectedStyle.value,
            outputFormat: selectedOutputFormat.value,
            document: selectedDocument.value,
        }, authStore.token);
        notice.value = `语音生成完成，识别语言为 ${response.language_label}`;
        languageLabel.value = response.language_label;
        await loadRecords();
        const latestRecord = records.value.find((record) => record.id === response.record.id) || response.record;
        await selectRecord(latestRecord);
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '语音生成失败';
    }
    finally {
        loading.value = false;
    }
}
async function selectRecord(record) {
    selectedRecord.value = record;
    languageLabel.value = record.detected_language;
    if (!authStore.token) {
        return;
    }
    if (audioUrl.value) {
        URL.revokeObjectURL(audioUrl.value);
    }
    const blob = await fetchSpeechAudio(record.id, authStore.token);
    audioUrl.value = URL.createObjectURL(blob);
}
async function handleDownload(recordId) {
    const record = records.value.find((item) => item.id === recordId);
    if (!authStore.token) {
        return;
    }
    try {
        const { blob, filename } = await downloadSpeechAudio(recordId, authStore.token);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename || record?.stored_filename || `speech-${recordId}.wav`;
        anchor.click();
        URL.revokeObjectURL(url);
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '下载失败';
    }
}
async function handleDelete(recordId) {
    if (!authStore.token) {
        return;
    }
    const confirmed = window.confirm('确认删除这条已生成语音记录吗？');
    if (!confirmed) {
        return;
    }
    errorMessage.value = '';
    notice.value = '';
    try {
        await deleteSpeechGeneration(recordId, authStore.token);
        if (selectedRecord.value?.id === recordId) {
            selectedRecord.value = null;
            languageLabel.value = '待识别';
            if (audioUrl.value) {
                URL.revokeObjectURL(audioUrl.value);
                audioUrl.value = '';
            }
        }
        await loadRecords();
        if (!selectedRecord.value && records.value.length) {
            await selectRecord(records.value[0]);
        }
        notice.value = '语音记录已删除';
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '删除失败';
    }
}
onMounted(() => {
    loadRecords().catch((error) => {
        errorMessage.value = error instanceof Error ? error.message : '加载语音生成记录失败';
    });
});
onUnmounted(() => {
    if (audioUrl.value) {
        URL.revokeObjectURL(audioUrl.value);
    }
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "page-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "helper-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-grid" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.textarea, __VLS_intrinsicElements.textarea)({
    value: (__VLS_ctx.textInput),
    placeholder: "请输入要转换为语音的文本",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onChange: (__VLS_ctx.handleDocumentChange) },
    type: "file",
    accept: ".txt,.md,.docx",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "style-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.selectedStyle),
});
for (const [style] of __VLS_getVForSourceType((__VLS_ctx.styleOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (style.value),
        value: (style.value),
    });
    (style.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.selectedOutputFormat),
});
for (const [format] of __VLS_getVForSourceType((__VLS_ctx.outputFormatOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (format.value),
        value: (format.value),
    });
    (format.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "toolbar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.handleGenerate) },
    ...{ class: "primary-button" },
    type: "button",
    disabled: (__VLS_ctx.loading),
});
(__VLS_ctx.loading ? '生成中...' : '生成语音');
if (__VLS_ctx.selectedDocument) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "status-badge" },
    });
    (__VLS_ctx.selectedDocument.name);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "status-badge" },
});
(__VLS_ctx.languageLabel);
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
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel history-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
if (__VLS_ctx.selectedRecord) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "helper-text" },
    });
    (__VLS_ctx.selectedRecord.style);
    (__VLS_ctx.selectedRecord.voice_name);
}
if (__VLS_ctx.audioUrl) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.audio, __VLS_intrinsicElements.audio)({
        ...{ class: "audio-player" },
        src: (__VLS_ctx.audioUrl),
        controls: true,
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-state" },
    });
}
if (__VLS_ctx.selectedRecord) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "toolbar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.selectedRecord))
                    return;
                __VLS_ctx.handleDownload(__VLS_ctx.selectedRecord.id);
            } },
        ...{ class: "primary-button" },
        type: "button",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.selectedRecord))
                    return;
                __VLS_ctx.handleDelete(__VLS_ctx.selectedRecord.id);
            } },
        ...{ class: "ghost-button" },
        type: "button",
    });
}
if (__VLS_ctx.selectedRecord) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.textarea, __VLS_intrinsicElements.textarea)({
        value: (__VLS_ctx.selectedRecord.input_text),
        readonly: true,
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
if (__VLS_ctx.records.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "table-wrap" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.table, __VLS_intrinsicElements.table)({
        ...{ class: "table auto-width-table" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
    for (const [record] of __VLS_getVForSourceType((__VLS_ctx.records))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
            key: (record.id),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        (__VLS_ctx.formatBackendDateTime(record.created_at));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        (record.original_filename || '文本输入');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        (record.detected_language);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        (record.style);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        (record.voice_name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "table-actions" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.records.length))
                        return;
                    __VLS_ctx.selectRecord(record);
                } },
            ...{ class: "secondary-button" },
            type: "button",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.records.length))
                        return;
                    __VLS_ctx.handleDownload(record.id);
                } },
            ...{ class: "ghost-button" },
            type: "button",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.records.length))
                        return;
                    __VLS_ctx.handleDelete(record.id);
                } },
            ...{ class: "ghost-button" },
            type: "button",
        });
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-state" },
    });
}
/** @type {__VLS_StyleScopedClasses['page-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['style-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['primary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['success-box']} */ ;
/** @type {__VLS_StyleScopedClasses['error-box']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['history-card']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
/** @type {__VLS_StyleScopedClasses['audio-player']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['primary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['table-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['table']} */ ;
/** @type {__VLS_StyleScopedClasses['auto-width-table']} */ ;
/** @type {__VLS_StyleScopedClasses['table-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            formatBackendDateTime: formatBackendDateTime,
            textInput: textInput,
            selectedStyle: selectedStyle,
            selectedOutputFormat: selectedOutputFormat,
            selectedDocument: selectedDocument,
            records: records,
            selectedRecord: selectedRecord,
            audioUrl: audioUrl,
            languageLabel: languageLabel,
            notice: notice,
            errorMessage: errorMessage,
            loading: loading,
            styleOptions: styleOptions,
            outputFormatOptions: outputFormatOptions,
            handleDocumentChange: handleDocumentChange,
            handleGenerate: handleGenerate,
            selectRecord: selectRecord,
            handleDownload: handleDownload,
            handleDelete: handleDelete,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
