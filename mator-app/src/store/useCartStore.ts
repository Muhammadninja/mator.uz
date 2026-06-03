// src/store/useCartStore.ts
import type { CartItem, Stock } from '@/types';
import { create } from 'zustand';

interface CartState {
  items: CartItem[];
  isLoading: boolean;
  error: string | null;
  addItem: (stock: Stock) => void;
  removeItem: (stockId: number) => void;
  updateQuantity: (stockId: number, quantity: number) => void;
  clear: () => void;
  totalUzs: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  isLoading: false,
  error: null,

  addItem: (stock) =>
    set((state) => {
      const existing = state.items.find((i) => i.stock.id === stock.id);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.stock.id === stock.id ? { ...i, quantity: i.quantity + 1 } : i,
          ),
        };
      }
      return { items: [...state.items, { stock, quantity: 1 }] };
    }),

  removeItem: (stockId) =>
    set((state) => ({ items: state.items.filter((i) => i.stock.id !== stockId) })),

  updateQuantity: (stockId, quantity) =>
    set((state) => ({
      items: quantity <= 0
        ? state.items.filter((i) => i.stock.id !== stockId)
        : state.items.map((i) => (i.stock.id === stockId ? { ...i, quantity } : i)),
    })),

  clear: () => set({ items: [] }),

  totalUzs: () =>
    get().items.reduce(
      (sum, item) => sum + parseFloat(item.stock.priceUzs) * item.quantity,
      0,
    ),
}));
