import { ref, watch } from 'vue';
const props = defineProps();
const emit = defineEmits();
const uploadSize = ref(100);
const japaneseTtsDictionary = ref('');
const japaneseTranscriptCorrections = ref('');
watch(() => props.setting, (value) => {
    if (value) {
        uploadSize.value = value.max_upload_size_mb;
        japaneseTtsDictionary.value = formatDictionaryEntries(value.japanese_tts_dictionary);
        japaneseTranscriptCorrections.value = formatDictionaryEntries(value.japanese_transcript_corrections);
    }
}, { immediate: true });
function formatDictionaryEntries(entries) {
    return Object.entries(entries)
        .sort(([left], [right]) => left.localeCompare(right, 'ja-JP'))
        .map(([term, reading]) => `${term} = ${reading}`)
        .join('\n');
}
function parseDictionaryEntries(rawValue) {
    const result = {};
    for (const rawLine of rawValue.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const delimiterIndex = line.includes('=') ? line.indexOf('=') : line.indexOf(':');
        if (delimiterIndex === -1) {
            continue;
        }
        const key = line.slice(0, delimiterIndex).trim();
        const value = line.slice(delimiterIndex + 1).trim();
        if (key && value) {
            result[key] = value;
        }
    }
    return result;
}
function handleSave() {
    emit('save', {
        max_upload_size_mb: uploadSize.value,
        japanese_tts_dictionary: parseDictionaryEntries(japaneseTtsDictionary.value),
        japanese_transcript_corrections: parseDictionaryEntries(japaneseTranscriptCorrections.value),
    });
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-grid" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    type: "number",
    min: "1",
});
(__VLS_ctx.uploadSize);
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.textarea, __VLS_intrinsicElements.textarea)({
    value: (__VLS_ctx.japaneseTtsDictionary),
    rows: "8",
    placeholder: "术语 = 读音&#10;例：胡さん = こさん",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.textarea, __VLS_intrinsicElements.textarea)({
    value: (__VLS_ctx.japaneseTranscriptCorrections),
    rows: "8",
    placeholder: "错误词 = 正确词&#10;例：子さん = 胡さん",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.handleSave) },
    ...{ class: "primary-button" },
    type: "button",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "helper-text" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['primary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            uploadSize: uploadSize,
            japaneseTtsDictionary: japaneseTtsDictionary,
            japaneseTranscriptCorrections: japaneseTranscriptCorrections,
            handleSave: handleSave,
        };
    },
    __typeEmits: {},
    __typeProps: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeEmits: {},
    __typeProps: {},
});
; /* PartiallyEnd: #4569/main.vue */
