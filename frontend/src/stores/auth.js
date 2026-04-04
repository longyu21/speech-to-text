import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { getCurrentUser, login as loginRequest } from '@/api/client';
const TOKEN_KEY = 'speech-to-text-token';
export const useAuthStore = defineStore('auth', () => {
    const token = ref(localStorage.getItem(TOKEN_KEY));
    const user = ref(null);
    const loading = ref(false);
    const isAuthenticated = computed(() => Boolean(token.value));
    const isAdmin = computed(() => user.value?.role === 'admin');
    const canAccessAdmin = computed(() => Boolean(user.value?.can_manage_users ||
        user.value?.can_manage_settings ||
        user.value?.can_view_audit_logs));
    async function login(username, password) {
        loading.value = true;
        try {
            const response = await loginRequest(username, password);
            token.value = response.access_token;
            localStorage.setItem(TOKEN_KEY, response.access_token);
            await fetchMe();
        }
        finally {
            loading.value = false;
        }
    }
    async function fetchMe() {
        if (!token.value) {
            user.value = null;
            return;
        }
        user.value = await getCurrentUser(token.value);
    }
    function logout() {
        token.value = null;
        user.value = null;
        localStorage.removeItem(TOKEN_KEY);
    }
    return {
        token,
        user,
        loading,
        isAuthenticated,
        isAdmin,
        canAccessAdmin,
        login,
        fetchMe,
        logout,
    };
});
