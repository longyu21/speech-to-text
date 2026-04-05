import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import AdminView from '@/views/AdminView.vue';
import HomeView from '@/views/HomeView.vue';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
import TextToSpeechView from '@/views/TextToSpeechView.vue';
import UrlTranscriptionView from '@/views/UrlTranscriptionView.vue';
const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/login', name: 'login', component: LoginView },
        { path: '/register', name: 'register', component: RegisterView },
        { path: '/', name: 'home', component: HomeView, meta: { requiresAuth: true } },
        { path: '/url-transcription', name: 'url-transcription', component: UrlTranscriptionView, meta: { requiresAuth: true } },
        { path: '/speech-generation', name: 'speech-generation', component: TextToSpeechView, meta: { requiresAuth: true } },
        { path: '/admin', name: 'admin', component: AdminView, meta: { requiresAuth: true, requiresAdmin: true } },
    ],
});
router.beforeEach(async (to) => {
    const authStore = useAuthStore();
    if (authStore.token && !authStore.user) {
        try {
            await authStore.fetchMe();
        }
        catch {
            authStore.logout();
        }
    }
    if (to.meta.requiresAuth && !authStore.isAuthenticated) {
        return { name: 'login' };
    }
    if ((to.name === 'login' || to.name === 'register') && authStore.isAuthenticated) {
        return { name: 'home' };
    }
    if (to.meta.requiresAdmin && !authStore.canAccessAdmin) {
        return { name: 'home' };
    }
    return true;
});
export default router;
