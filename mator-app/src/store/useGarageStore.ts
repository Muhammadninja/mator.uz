// src/store/useGarageStore.ts
import type { Vehicle } from '@/types';
import { create } from 'zustand';

interface GarageState {
  vehicles: Vehicle[];
  activeVehicleId: string | null;
  isLoading: boolean;
  error: string | null;
  addVehicle: (vehicle: Vehicle) => void;
  removeVehicle: (id: string) => void;
  setActiveVehicle: (id: string) => void;
}

export const useGarageStore = create<GarageState>((set) => ({
  vehicles: [],
  activeVehicleId: null,
  isLoading: false,
  error: null,

  addVehicle: (vehicle) =>
    set((state) => ({ vehicles: [...state.vehicles, vehicle] })),

  removeVehicle: (id) =>
    set((state) => ({
      vehicles: state.vehicles.filter((v) => v.id !== id),
      activeVehicleId: state.activeVehicleId === id ? null : state.activeVehicleId,
    })),

  setActiveVehicle: (id) => set({ activeVehicleId: id }),
}));
