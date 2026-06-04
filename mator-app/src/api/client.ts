// src/api/client.ts
import axios from 'axios';
import Constants from 'expo-constants';

const BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  'http://localhost:3001';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT from store on every request
apiClient.interceptors.request.use((config) => {
  // Token will be injected by useAuthStore when implemented
  return config;
});
