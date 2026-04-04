import { onMounted, ref } from 'vue';
import { createUser, deleteUser, getSpeechLanguageSettings, listAuditLogs, listUsers, updateSpeechLanguageSettings, updateUser, } from '@/api/client';
import AdminAuditLogsPanel from '@/components/AdminAuditLogsPanel.vue';
import AdminSettingsPanel from '@/components/AdminSettingsPanel.vue';
import AdminUsersPanel from '@/components/AdminUsersPanel.vue';
import { useAuthStore } from '@/stores/auth';
const authStore = useAuthStore();
const users = ref([]);
const setting = ref(null);
const auditLogs = ref([]);
const notice = ref('');
const errorMessage = ref('');
async function loadAdminData() {
    if (!authStore.token) {
        return;
    }
    const tasks = [];
    if (authStore.user?.can_manage_users) {
        tasks.push(listUsers(authStore.token).then((response) => {
            users.value = response;
        }));
    }
    if (authStore.user?.can_manage_settings) {
        tasks.push(getSpeechLanguageSettings(authStore.token).then((response) => {
            setting.value = response;
        }));
    }
    if (authStore.user?.can_view_audit_logs) {
        tasks.push(listAuditLogs(authStore.token).then((response) => {
            auditLogs.value = response;
        }));
    }
    await Promise.all(tasks);
}
async function handleCreate(payload) {
    if (!authStore.token) {
        return;
    }
    await createUser(payload, authStore.token);
    notice.value = '用户已创建';
    await loadAdminData();
}
async function handleUpdate(userId, payload) {
    if (!authStore.token) {
        return;
    }
    await updateUser(userId, payload, authStore.token);
    notice.value = '用户信息已更新';
    await loadAdminData();
}
async function handleRemove(userId) {
    if (!authStore.token) {
        return;
    }
    await deleteUser(userId, authStore.token);
    notice.value = '用户已删除';
    await loadAdminData();
}
async function handleSaveSetting(payload) {
    if (!authStore.token) {
        return;
    }
    notice.value = '';
    errorMessage.value = '';
    try {
        setting.value = await updateSpeechLanguageSettings(payload, authStore.token);
        notice.value = '语音与转写词典设置已保存';
    }
    catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '设置保存失败';
    }
}
onMounted(() => {
    loadAdminData().catch((error) => {
        errorMessage.value = error instanceof Error ? error.message : '加载管理数据失败';
    });
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "admin-stack" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "eyebrow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
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
if (!__VLS_ctx.notice && !__VLS_ctx.errorMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "helper-text" },
    });
}
if (__VLS_ctx.authStore.user?.can_manage_users) {
    /** @type {[typeof AdminUsersPanel, ]} */ ;
    // @ts-ignore
    const __VLS_0 = __VLS_asFunctionalComponent(AdminUsersPanel, new AdminUsersPanel({
        ...{ 'onCreate': {} },
        ...{ 'onUpdate': {} },
        ...{ 'onRemove': {} },
        users: (__VLS_ctx.users),
    }));
    const __VLS_1 = __VLS_0({
        ...{ 'onCreate': {} },
        ...{ 'onUpdate': {} },
        ...{ 'onRemove': {} },
        users: (__VLS_ctx.users),
    }, ...__VLS_functionalComponentArgsRest(__VLS_0));
    let __VLS_3;
    let __VLS_4;
    let __VLS_5;
    const __VLS_6 = {
        onCreate: (__VLS_ctx.handleCreate)
    };
    const __VLS_7 = {
        onUpdate: (__VLS_ctx.handleUpdate)
    };
    const __VLS_8 = {
        onRemove: (__VLS_ctx.handleRemove)
    };
    var __VLS_2;
}
if (__VLS_ctx.authStore.user?.can_manage_settings) {
    /** @type {[typeof AdminSettingsPanel, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(AdminSettingsPanel, new AdminSettingsPanel({
        ...{ 'onSave': {} },
        setting: (__VLS_ctx.setting),
    }));
    const __VLS_10 = __VLS_9({
        ...{ 'onSave': {} },
        setting: (__VLS_ctx.setting),
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    let __VLS_12;
    let __VLS_13;
    let __VLS_14;
    const __VLS_15 = {
        onSave: (__VLS_ctx.handleSaveSetting)
    };
    var __VLS_11;
}
if (__VLS_ctx.authStore.user?.can_view_audit_logs) {
    /** @type {[typeof AdminAuditLogsPanel, ]} */ ;
    // @ts-ignore
    const __VLS_16 = __VLS_asFunctionalComponent(AdminAuditLogsPanel, new AdminAuditLogsPanel({
        logs: (__VLS_ctx.auditLogs),
    }));
    const __VLS_17 = __VLS_16({
        logs: (__VLS_ctx.auditLogs),
    }, ...__VLS_functionalComponentArgsRest(__VLS_16));
}
/** @type {__VLS_StyleScopedClasses['admin-stack']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['eyebrow']} */ ;
/** @type {__VLS_StyleScopedClasses['success-box']} */ ;
/** @type {__VLS_StyleScopedClasses['error-box']} */ ;
/** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            AdminAuditLogsPanel: AdminAuditLogsPanel,
            AdminSettingsPanel: AdminSettingsPanel,
            AdminUsersPanel: AdminUsersPanel,
            authStore: authStore,
            users: users,
            setting: setting,
            auditLogs: auditLogs,
            notice: notice,
            errorMessage: errorMessage,
            handleCreate: handleCreate,
            handleUpdate: handleUpdate,
            handleRemove: handleRemove,
            handleSaveSetting: handleSaveSetting,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
