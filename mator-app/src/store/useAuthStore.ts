// src/store/useAuthStore.ts
import { apiClient } from '@/api/client';
import { create } from 'zustand';

interface AuthState {
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (tgId: string, phone: string) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  isLoading: false,
  error: null,

  login: async (tgId, phone) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await apiClient.post<{ token: string }>('/auth/login', { tgId, phone });
      apiClient.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;
      set({ token: data.token, isLoading: false });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : 'Login failed';
      set({ error, isLoading: false });
    }
  },

  logout: () => {
    delete apiClient.defaults.headers.common['Authorization'];
    set({ token: null, error: null });
  },
}));
