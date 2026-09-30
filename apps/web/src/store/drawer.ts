import { create } from "zustand";
import type { GVRKey } from "@/lib/k8s";

export interface DrawerTarget {
  gvr: GVRKey;
  namespace: string;
  name: string;
  kind?: string;
}

interface DrawerState {
  target: DrawerTarget | null;
  open(t: DrawerTarget): void;
  close(): void;
}

export const useDrawer = create<DrawerState>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
