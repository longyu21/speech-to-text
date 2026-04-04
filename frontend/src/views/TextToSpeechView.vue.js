import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { createSpeechGeneration, deleteSpeechGeneration, downloadSpeechAudio, fetchSpeechAudio, getSpeechGenerationOptions, listSpeechGenerations, updateSpeechFavoriteVoices } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { formatBackendDateTime } from '@/utils/datetime';
const FAVORITE_VOICE_STORAGE_KEY = 'speech.favoriteVoices';
const RECENT_VOICE_STORAGE_KEY = 'speech.recentVoices';
const MAX_RECENT_VOICES = 6;
const authStore = useAuthStore();
const textInput = ref('');
const selectedStyle = ref('normal');
const selectedOutputFormat = ref('mp3');
const selectedVoiceId = ref('');
const selectedSpeedRate = ref(0);
const selectedVoiceLanguage = ref('all');
const selectedVoiceSource = ref('all');
const voiceSearchKeyword = ref('');
const favoritesOnly = ref(false);
const selectedDocument = ref(null);
const records = ref([]);
const selectedRecord = ref(null);
const audioUrl = ref('');
const languageLabel = ref('待识别');
const voiceOptions = ref([]);
const speedOptions = ref([]);
const favoriteVoiceIds = ref([]);
const recentVoiceIds = ref([]);
const pendingLegacyFavoriteVoiceIds = ref([]);
const notice = ref('');
const errorMessage = ref('');
const loading = ref(false);
const MESSAGE_TIMEOUT_MS = 4000;
const favoriteSaving = ref(false);
const dragSection = ref(null);
const dragVoiceId = ref(null);
let noticeTimer = null;
let errorTimer = null;
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
const voiceLanguageOptions = computed(() => {
    const languages = new Map();
    voiceOptions.value.forEach((voice) => {
        if (voice.locale.startsWith('ja')) {
            languages.set('ja', '日语');
            return;
        }
        if (voice.locale.startsWith('zh')) {
            languages.set('zh', '中文');
            return;
        }
        if (voice.locale.startsWith('en')) {
            languages.set('en', '英语');
            return;
        }
        if (voice.locale) {
            languages.set(voice.locale, voice.locale);
        }
    });
    return [{ value: 'all', label: '全部语言' }, ...Array.from(languages.entries()).map(([value, label]) => ({ value, label }))];
});
const voiceSourceOptions = computed(() => [
    { value: 'all', label: '全部来源' },
    { value: 'system', label: '系统内置' },
    { value: 'edge', label: '联网音色' },
]);
const filteredVoiceOptions = computed(() => {
    const keyword = voiceSearchKeyword.value.trim().toLowerCase();
    return voiceOptions.value.filter((voice) => {
        const languageMatched = selectedVoiceLanguage.value === 'all'
            || (selectedVoiceLanguage.value === 'ja' && voice.locale.startsWith('ja'))
            || (selectedVoiceLanguage.value === 'zh' && voice.locale.startsWith('zh'))
            || (selectedVoiceLanguage.value === 'en' && voice.locale.startsWith('en'))
            || voice.locale === selectedVoiceLanguage.value;
        const sourceMatched = selectedVoiceSource.value === 'all' || voice.provider === selectedVoiceSource.value;
        const searchMatched = !keyword || buildVoiceSearchText(voice).includes(keyword);
        const favoriteMatched = !favoritesOnly.value || isFavoriteVoice(voice.id);
        return languageMatched && sourceMatched && searchMatched && favoriteMatched;
    }).sort((left, right) => {
        const leftFavorite = favoriteVoiceIds.value.includes(left.id) ? 1 : 0;
        const rightFavorite = favoriteVoiceIds.value.includes(right.id) ? 1 : 0;
        if (leftFavorite !== rightFavorite) {
            return rightFavorite - leftFavorite;
        }
        return left.display_name.localeCompare(right.display_name, 'zh-CN');
    });
});
const favoriteVoices = computed(() => mapVoiceIdsToOptions(favoriteVoiceIds.value));
const recentVoices = computed(() => mapVoiceIdsToOptions(recentVoiceIds.value));
function mapVoiceIdsToOptions(voiceIds) {
    const byId = new Map(voiceOptions.value.map((voice) => [voice.id, voice]));
    return voiceIds
        .map((voiceId) => byId.get(normalizeVoiceId(voiceId)))
        .filter((voice) => Boolean(voice));
}
function normalizeVoiceId(voiceId) {
    const availableVoiceIds = new Set(voiceOptions.value.map((voice) => voice.id));
    if (availableVoiceIds.has(voiceId)) {
        return voiceId;
    }
    const variantBaseId = `${voiceId}::variant::base`;
    if (availableVoiceIds.has(variantBaseId)) {
        return variantBaseId;
    }
    return voiceId;
}
function normalizeVoiceIds(voiceIds) {
    return Array.from(new Set(voiceIds.map((voiceId) => normalizeVoiceId(voiceId))));
}
function buildVoiceSearchText(voice) {
    return [
        voice.display_name,
        voice.character_name,
        voice.persona_name || '',
        voice.language_label,
        voice.locale,
        voice.source,
        voice.gender || '',
        voice.personality_tags.join(' '),
    ].join(' ').toLowerCase();
}
function readStoredVoiceIds(storageKey) {
    try {
        const rawValue = localStorage.getItem(storageKey);
        if (!rawValue) {
            return [];
        }
        const parsed = JSON.parse(rawValue);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    }
    catch {
        return [];
    }
}
function writeStoredVoiceIds(storageKey, voiceIds) {
    localStorage.setItem(storageKey, JSON.stringify(voiceIds));
}
async function syncVoicePreferences(payload, persistNotice) {
    if (!authStore.token) {
        return;
    }
    favoriteSaving.value = true;
    try {
        const response = await updateSpeechFavoriteVoices({
            favorite_voice_ids: payload.favoriteVoiceIds,
            recent_voice_ids: payload.recentVoiceIds,
        }, authStore.token);
        favoriteVoiceIds.value = response.favorite_voice_ids;
        recentVoiceIds.value = response.recent_voice_ids;
        writeStoredVoiceIds(FAVORITE_VOICE_STORAGE_KEY, response.favorite_voice_ids);
        writeStoredVoiceIds(RECENT_VOICE_STORAGE_KEY, response.recent_voice_ids);
        if (persistNotice) {
            notice.value = persistNotice;
        }
    }
    finally {
        favoriteSaving.value = false;
    }
}
async function toggleFavoriteVoice(voiceId) {
    const nextFavorites = favoriteVoiceIds.value.includes(voiceId)
        ? favoriteVoiceIds.value.filter((item) => item !== voiceId)
        : [voiceId, ...favoriteVoiceIds.value];
    try {
        errorMessage.value = '';
        await syncVoicePreferences({
            favoriteVoiceIds: nextFavorites,
            recentVoiceIds: recentVoiceIds.value,
        }, nextFavorites.includes(voiceId) ? '音色已加入收藏' : '已取消收藏音色');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '收藏音色保存失败';
    }
}
async function markVoiceAsRecentlyUsed(voiceId) {
    if (!voiceId) {
        return;
    }
    const nextRecent = [voiceId, ...recentVoiceIds.value.filter((item) => item !== voiceId)].slice(0, MAX_RECENT_VOICES);
    try {
        await syncVoicePreferences({
            favoriteVoiceIds: favoriteVoiceIds.value,
            recentVoiceIds: nextRecent,
        });
    }
    catch {
        recentVoiceIds.value = nextRecent;
        writeStoredVoiceIds(RECENT_VOICE_STORAGE_KEY, nextRecent);
    }
}
function applyVoiceSelection(voiceId) {
    selectedVoiceId.value = voiceId;
}
function reorderVoiceIds(voiceIds, draggedId, targetId) {
    if (draggedId === targetId) {
        return voiceIds;
    }
    const nextVoiceIds = [...voiceIds];
    const draggedIndex = nextVoiceIds.indexOf(draggedId);
    const targetIndex = nextVoiceIds.indexOf(targetId);
    if (draggedIndex === -1 || targetIndex === -1) {
        return voiceIds;
    }
    const [draggedVoiceId] = nextVoiceIds.splice(draggedIndex, 1);
    nextVoiceIds.splice(targetIndex, 0, draggedVoiceId);
    return nextVoiceIds;
}
async function persistFavoriteVoiceIds(nextFavoriteVoiceIds, persistNotice) {
    await syncVoicePreferences({
        favoriteVoiceIds: normalizeVoiceIds(nextFavoriteVoiceIds),
        recentVoiceIds: recentVoiceIds.value,
    }, persistNotice);
}
async function persistRecentVoiceIds(nextRecentVoiceIds, persistNotice) {
    await syncVoicePreferences({
        favoriteVoiceIds: favoriteVoiceIds.value,
        recentVoiceIds: normalizeVoiceIds(nextRecentVoiceIds),
    }, persistNotice);
}
async function removeFavoriteVoice(voiceId) {
    try {
        errorMessage.value = '';
        await persistFavoriteVoiceIds(favoriteVoiceIds.value.filter((item) => item !== voiceId), '已删除收藏音色');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '删除收藏音色失败';
    }
}
async function removeRecentVoice(voiceId) {
    try {
        errorMessage.value = '';
        await persistRecentVoiceIds(recentVoiceIds.value.filter((item) => item !== voiceId), '已删除最近使用音色');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '删除最近使用音色失败';
    }
}
async function clearFavoriteVoices() {
    try {
        errorMessage.value = '';
        await persistFavoriteVoiceIds([], '收藏音色已清空');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '清空收藏音色失败';
    }
}
async function clearRecentVoices() {
    try {
        errorMessage.value = '';
        await persistRecentVoiceIds([], '最近使用已清空');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '清空最近使用失败';
    }
}
async function moveFavoriteVoiceToTop(voiceId) {
    try {
        errorMessage.value = '';
        const nextFavoriteVoiceIds = [voiceId, ...favoriteVoiceIds.value.filter((item) => item !== voiceId)];
        await persistFavoriteVoiceIds(nextFavoriteVoiceIds, '收藏音色排序已更新');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '收藏音色排序失败';
    }
}
async function moveRecentVoiceToTop(voiceId) {
    try {
        errorMessage.value = '';
        const nextRecentVoiceIds = [voiceId, ...recentVoiceIds.value.filter((item) => item !== voiceId)];
        await persistRecentVoiceIds(nextRecentVoiceIds, '最近使用排序已更新');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '最近使用排序失败';
    }
}
async function moveFavoriteVoiceUp(voiceId) {
    const currentIndex = favoriteVoiceIds.value.indexOf(voiceId);
    if (currentIndex <= 0) {
        return;
    }
    const nextFavoriteVoiceIds = [...favoriteVoiceIds.value];
    [nextFavoriteVoiceIds[currentIndex - 1], nextFavoriteVoiceIds[currentIndex]] = [nextFavoriteVoiceIds[currentIndex], nextFavoriteVoiceIds[currentIndex - 1]];
    try {
        errorMessage.value = '';
        await persistFavoriteVoiceIds(nextFavoriteVoiceIds, '收藏音色排序已更新');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '收藏音色排序失败';
    }
}
async function moveRecentVoiceUp(voiceId) {
    const currentIndex = recentVoiceIds.value.indexOf(voiceId);
    if (currentIndex <= 0) {
        return;
    }
    const nextRecentVoiceIds = [...recentVoiceIds.value];
    [nextRecentVoiceIds[currentIndex - 1], nextRecentVoiceIds[currentIndex]] = [nextRecentVoiceIds[currentIndex], nextRecentVoiceIds[currentIndex - 1]];
    try {
        errorMessage.value = '';
        await persistRecentVoiceIds(nextRecentVoiceIds, '最近使用排序已更新');
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '最近使用排序失败';
    }
}
function handleVoiceDragStart(section, voiceId) {
    dragSection.value = section;
    dragVoiceId.value = voiceId;
}
function handleVoiceDragEnd() {
    dragSection.value = null;
    dragVoiceId.value = null;
}
async function handleVoiceDrop(section, targetVoiceId) {
    if (!dragVoiceId.value || dragSection.value !== section) {
        handleVoiceDragEnd();
        return;
    }
    try {
        errorMessage.value = '';
        if (section === 'favorite') {
            const nextFavoriteVoiceIds = reorderVoiceIds(favoriteVoiceIds.value, dragVoiceId.value, targetVoiceId);
            await persistFavoriteVoiceIds(nextFavoriteVoiceIds, '收藏音色排序已更新');
        }
        else {
            const nextRecentVoiceIds = reorderVoiceIds(recentVoiceIds.value, dragVoiceId.value, targetVoiceId);
            await persistRecentVoiceIds(nextRecentVoiceIds, '最近使用排序已更新');
        }
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '音色排序失败';
    }
    finally {
        handleVoiceDragEnd();
    }
}
function isFavoriteVoice(voiceId) {
    const normalizedVoiceId = normalizeVoiceId(voiceId);
    return normalizeVoiceIds(favoriteVoiceIds.value).includes(normalizedVoiceId);
}
async function loadOptions() {
    if (!authStore.token) {
        return;
    }
    const response = await getSpeechGenerationOptions(authStore.token);
    voiceOptions.value = response.voices;
    speedOptions.value = response.speeds;
    const normalizedFavoriteVoiceIds = normalizeVoiceIds(response.favorite_voice_ids);
    const normalizedRecentVoiceIds = normalizeVoiceIds(response.recent_voice_ids);
    favoriteVoiceIds.value = normalizedFavoriteVoiceIds;
    recentVoiceIds.value = normalizedRecentVoiceIds;
    if (normalizedFavoriteVoiceIds.join('|') !== response.favorite_voice_ids.join('|')) {
        await syncVoicePreferences({
            favoriteVoiceIds: normalizedFavoriteVoiceIds,
            recentVoiceIds: normalizedRecentVoiceIds,
        });
        return;
    }
    if (normalizedRecentVoiceIds.join('|') !== response.recent_voice_ids.join('|')) {
        await syncVoicePreferences({
            favoriteVoiceIds: normalizedFavoriteVoiceIds,
            recentVoiceIds: normalizedRecentVoiceIds,
        });
        return;
    }
    if ((!normalizedFavoriteVoiceIds.length && pendingLegacyFavoriteVoiceIds.value.length) || (!normalizedRecentVoiceIds.length && recentVoiceIds.value.length)) {
        await syncVoicePreferences({
            favoriteVoiceIds: normalizedFavoriteVoiceIds.length ? normalizedFavoriteVoiceIds : normalizeVoiceIds(pendingLegacyFavoriteVoiceIds.value),
            recentVoiceIds: normalizedRecentVoiceIds.length ? normalizedRecentVoiceIds : normalizeVoiceIds(readStoredVoiceIds(RECENT_VOICE_STORAGE_KEY)),
        });
    }
}
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
            voiceId: selectedVoiceId.value || null,
            speedRate: selectedSpeedRate.value,
            document: selectedDocument.value,
        }, authStore.token);
        notice.value = `语音生成完成，识别语言为 ${response.language_label}`;
        languageLabel.value = response.language_label;
        await markVoiceAsRecentlyUsed(selectedVoiceId.value || null);
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
    pendingLegacyFavoriteVoiceIds.value = readStoredVoiceIds(FAVORITE_VOICE_STORAGE_KEY);
    recentVoiceIds.value = readStoredVoiceIds(RECENT_VOICE_STORAGE_KEY);
    Promise.all([loadOptions(), loadRecords()]).catch((error) => {
        errorMessage.value = error instanceof Error ? error.message : '加载语音生成记录失败';
    });
});
watch(notice, () => {
    scheduleMessageClear('notice');
});
watch(errorMessage, () => {
    scheduleMessageClear('error');
});
onUnmounted(() => {
    if (audioUrl.value) {
        URL.revokeObjectURL(audioUrl.value);
    }
    resetMessageTimer('notice');
    resetMessageTimer('error');
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__header']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-filter-toggle']} */ ;
// CSS variable injection 
// CSS variable injection end 
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
    ...{ class: "style-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.selectedVoiceLanguage),
});
for (const [option] of __VLS_getVForSourceType((__VLS_ctx.voiceLanguageOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (option.value),
        value: (option.value),
    });
    (option.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.selectedVoiceSource),
});
for (const [option] of __VLS_getVForSourceType((__VLS_ctx.voiceSourceOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (option.value),
        value: (option.value),
    });
    (option.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "voice-filter-toggle" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "toggle-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    type: "checkbox",
});
(__VLS_ctx.favoritesOnly);
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    value: (__VLS_ctx.voiceSearchKeyword),
    type: "text",
    placeholder: "输入人物名、场景名、语言或来源，例如 Nanami、明亮、系统内置",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-grid" },
    ...{ style: {} },
});
if (__VLS_ctx.favoriteVoices.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "voice-shortcuts" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "voice-shortcuts__header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "helper-text" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.clearFavoriteVoices) },
        ...{ class: "ghost-button voice-shortcuts__clear" },
        type: "button",
        disabled: (__VLS_ctx.favoriteSaving),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "voice-shortcuts__list" },
    });
    for (const [voice] of __VLS_getVForSourceType((__VLS_ctx.favoriteVoices))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onDragstart: (...[$event]) => {
                    if (!(__VLS_ctx.favoriteVoices.length))
                        return;
                    __VLS_ctx.handleVoiceDragStart('favorite', voice.id);
                } },
            ...{ onDragend: (__VLS_ctx.handleVoiceDragEnd) },
            ...{ onDragover: () => { } },
            ...{ onDrop: (...[$event]) => {
                    if (!(__VLS_ctx.favoriteVoices.length))
                        return;
                    __VLS_ctx.handleVoiceDrop('favorite', voice.id);
                } },
            key: (`favorite-${voice.id}`),
            ...{ class: "voice-shortcuts__item" },
            draggable: "true",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.favoriteVoices.length))
                        return;
                    __VLS_ctx.removeFavoriteVoice(voice.id);
                } },
            ...{ class: "voice-shortcuts__remove" },
            type: "button",
            disabled: (__VLS_ctx.favoriteSaving),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.favoriteVoices.length))
                        return;
                    __VLS_ctx.applyVoiceSelection(voice.id);
                } },
            ...{ class: "ghost-button voice-shortcuts__select" },
            type: "button",
        });
        (voice.character_name);
        (voice.persona_name ? ` / ${voice.persona_name}` : '');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "voice-shortcuts__actions" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.favoriteVoices.length))
                        return;
                    __VLS_ctx.moveFavoriteVoiceToTop(voice.id);
                } },
            ...{ class: "secondary-button voice-shortcuts__action" },
            type: "button",
            disabled: (__VLS_ctx.favoriteSaving),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.favoriteVoices.length))
                        return;
                    __VLS_ctx.moveFavoriteVoiceUp(voice.id);
                } },
            ...{ class: "secondary-button voice-shortcuts__action" },
            type: "button",
            disabled: (__VLS_ctx.favoriteSaving),
        });
    }
}
if (__VLS_ctx.recentVoices.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "voice-shortcuts" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "voice-shortcuts__header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "helper-text" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.clearRecentVoices) },
        ...{ class: "ghost-button voice-shortcuts__clear" },
        type: "button",
        disabled: (__VLS_ctx.favoriteSaving),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "voice-shortcuts__list" },
    });
    for (const [voice] of __VLS_getVForSourceType((__VLS_ctx.recentVoices))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onDragstart: (...[$event]) => {
                    if (!(__VLS_ctx.recentVoices.length))
                        return;
                    __VLS_ctx.handleVoiceDragStart('recent', voice.id);
                } },
            ...{ onDragend: (__VLS_ctx.handleVoiceDragEnd) },
            ...{ onDragover: () => { } },
            ...{ onDrop: (...[$event]) => {
                    if (!(__VLS_ctx.recentVoices.length))
                        return;
                    __VLS_ctx.handleVoiceDrop('recent', voice.id);
                } },
            key: (`recent-${voice.id}`),
            ...{ class: "voice-shortcuts__item voice-shortcuts__item--recent" },
            draggable: "true",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.recentVoices.length))
                        return;
                    __VLS_ctx.removeRecentVoice(voice.id);
                } },
            ...{ class: "voice-shortcuts__remove" },
            type: "button",
            disabled: (__VLS_ctx.favoriteSaving),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.recentVoices.length))
                        return;
                    __VLS_ctx.applyVoiceSelection(voice.id);
                } },
            ...{ class: "secondary-button voice-shortcuts__select" },
            type: "button",
        });
        (voice.character_name);
        (voice.persona_name ? ` / ${voice.persona_name}` : '');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "voice-shortcuts__actions" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.recentVoices.length))
                        return;
                    __VLS_ctx.moveRecentVoiceToTop(voice.id);
                } },
            ...{ class: "ghost-button voice-shortcuts__action" },
            type: "button",
            disabled: (__VLS_ctx.favoriteSaving),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.recentVoices.length))
                        return;
                    __VLS_ctx.moveRecentVoiceUp(voice.id);
                } },
            ...{ class: "ghost-button voice-shortcuts__action" },
            type: "button",
            disabled: (__VLS_ctx.favoriteSaving),
        });
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "style-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.selectedVoiceId),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
    value: "",
});
for (const [voice] of __VLS_getVForSourceType((__VLS_ctx.filteredVoiceOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (voice.id),
        value: (voice.id),
    });
    (voice.character_name);
    (voice.persona_name ? ` / ${voice.persona_name}` : '');
    (voice.language_label);
    (voice.source);
    (voice.gender ? ` / ${voice.gender}` : '');
}
if (__VLS_ctx.selectedVoiceId) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "table-actions" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.selectedVoiceId))
                    return;
                __VLS_ctx.toggleFavoriteVoice(__VLS_ctx.selectedVoiceId);
            } },
        ...{ class: "ghost-button" },
        type: "button",
        disabled: (__VLS_ctx.favoriteSaving),
    });
    (__VLS_ctx.isFavoriteVoice(__VLS_ctx.selectedVoiceId) ? '取消收藏当前音色' : '收藏当前音色');
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.selectedSpeedRate),
});
for (const [speed] of __VLS_getVForSourceType((__VLS_ctx.speedOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (speed.value),
        value: (speed.value),
    });
    (speed.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "helper-text" },
});
(__VLS_ctx.filteredVoiceOptions.length);
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
/** @type {__VLS_StyleScopedClasses['style-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-filter-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['toggle-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__header']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__clear']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__list']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__item']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__remove']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__select']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__actions']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__action']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__action']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__header']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__clear']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__list']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__item']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__item--recent']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__remove']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__select']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__actions']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__action']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['voice-shortcuts__action']} */ ;
/** @type {__VLS_StyleScopedClasses['style-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['table-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['ghost-button']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
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
            selectedVoiceId: selectedVoiceId,
            selectedSpeedRate: selectedSpeedRate,
            selectedVoiceLanguage: selectedVoiceLanguage,
            selectedVoiceSource: selectedVoiceSource,
            voiceSearchKeyword: voiceSearchKeyword,
            favoritesOnly: favoritesOnly,
            selectedDocument: selectedDocument,
            records: records,
            selectedRecord: selectedRecord,
            audioUrl: audioUrl,
            languageLabel: languageLabel,
            speedOptions: speedOptions,
            notice: notice,
            errorMessage: errorMessage,
            loading: loading,
            favoriteSaving: favoriteSaving,
            styleOptions: styleOptions,
            outputFormatOptions: outputFormatOptions,
            voiceLanguageOptions: voiceLanguageOptions,
            voiceSourceOptions: voiceSourceOptions,
            filteredVoiceOptions: filteredVoiceOptions,
            favoriteVoices: favoriteVoices,
            recentVoices: recentVoices,
            toggleFavoriteVoice: toggleFavoriteVoice,
            applyVoiceSelection: applyVoiceSelection,
            removeFavoriteVoice: removeFavoriteVoice,
            removeRecentVoice: removeRecentVoice,
            clearFavoriteVoices: clearFavoriteVoices,
            clearRecentVoices: clearRecentVoices,
            moveFavoriteVoiceToTop: moveFavoriteVoiceToTop,
            moveRecentVoiceToTop: moveRecentVoiceToTop,
            moveFavoriteVoiceUp: moveFavoriteVoiceUp,
            moveRecentVoiceUp: moveRecentVoiceUp,
            handleVoiceDragStart: handleVoiceDragStart,
            handleVoiceDragEnd: handleVoiceDragEnd,
            handleVoiceDrop: handleVoiceDrop,
            isFavoriteVoice: isFavoriteVoice,
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
