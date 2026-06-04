// src/types/index.ts — Shared domain types mirroring the DB schema

export interface Seller {
  id: number;
  tgId: string;
  phone: string;
  storeName: string | null;
  marketName: string | null;
}

export interface Product {
  id: number;
  gmNumber: string | null;
  title: string;
  carModel: string | null;
  imageUrl: string | null;
  createdAt: string;
}

export interface Stock {
  id: number;
  sellerId: number;
  productId: number;
  priceUzs: string; // Decimal serialized as string
  quantity: number;
  updatedAt: string;
  product?: Product;
  seller?: Seller;
}

export interface Order {
  id: number;
  userId: number;
  status: 'paid' | 'courier_searching' | 'in_delivery' | 'delivered';
  yandexClaimId: string | null;
  deliveryCost: string | null;
  totalCost: string | null;
  createdAt: string;
}

export interface CartItem {
  stock: Stock;
  quantity: number;
}

export interface Vehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  licensePlate?: string;
  vin?: string;
}

export type Language = 'ru' | 'uz';
