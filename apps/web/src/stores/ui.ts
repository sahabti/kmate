import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UIState {
  namespace: string; // "" = all
  search: string;
  sidebarCollapsed: boolean;
  setNamespace(ns: string): void;
  setSearch(s: string): void;
  toggleSidebar(): void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      namespace: "",
      search: "",
      sidebarCollapsed: false,
      setNamespace: (namespace) => set({ namespace }),
      setSearch: (search) => set({ search }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    { name: "kmate.ui", partialize: (s) => ({ namespace: s.namespace, sidebarCollapsed: s.sidebarCollapsed }) },
  ),
);
