// src/store/useChatStore.ts
import { apiClient } from '@/api/client';
import { create } from 'zustand';

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  clear: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  error: null,

  sendMessage: async (text) => {
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      createdAt: new Date(),
    };
    set((state) => ({ messages: [...state.messages, userMsg], isLoading: true, error: null }));

    try {
      const { data } = await apiClient.post<{ reply: string }>('/chat', {
        messages: get().messages.map(({ role, content }) => ({ role, content })),
      });

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.reply,
        createdAt: new Date(),
      };
      set((state) => ({ messages: [...state.messages, assistantMsg], isLoading: false }));
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : 'Chat error';
      set({ isLoading: false, error });
    }
  },

  clear: () => set({ messages: [] }),
}));
