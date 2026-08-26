import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import * as authApi from '@/api/auth';
import { configureApiClient } from '@/api/client';
import type { AuthUser } from '@/api/types';

export const useAuthStore = defineStore('auth', () => {
  const accessToken = ref<string | null>(null);
  const user = ref<AuthUser | null>(null);
  const initialized = ref(false);
  const loading = ref(false);

  const isAuthenticated = computed(() => accessToken.value !== null && user.value !== null);
  const isAdmin = computed(() => user.value?.role === 'ADMIN');

  function setSession(token: string, nextUser: AuthUser): void {
    accessToken.value = token;
    user.value = nextUser;
  }

  function clearSession(): void {
    accessToken.value = null;
    user.value = null;
  }

  async function login(username: string, password: string): Promise<void> {
    loading.value = true;
    try {
      const response = await authApi.login(username, password);
      setSession(response.accessToken, response.user);
    } finally {
      loading.value = false;
    }
  }

  async function refreshSession(): Promise<boolean> {
    try {
      const response = await authApi.refresh();
      setSession(response.accessToken, response.user);
      return true;
    } catch {
      clearSession();
      return false;
    }
  }

  async function restoreSession(): Promise<void> {
    if (initialized.value) return;
    initialized.value = true;
    await refreshSession();
  }

  async function logout(): Promise<void> {
    try {
      if (accessToken.value || user.value) await authApi.logout();
    } finally {
      clearSession();
    }
  }

  configureApiClient({
    getAccessToken: () => accessToken.value,
    refreshAccessToken: refreshSession,
  });

  return {
    accessToken,
    user,
    initialized,
    loading,
    isAuthenticated,
    isAdmin,
    login,
    logout,
    refreshSession,
    restoreSession,
    clearSession,
  };
});
