import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  setTheme(t: Theme): void;
  toggle(): void;
}

function apply(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      setTheme(t) {
        apply(t);
        set({ theme: t });
      },
      toggle() {
        get().setTheme(get().theme === "dark" ? "light" : "dark");
      },
    }),
    {
      name: "kmate.theme",
      onRehydrateStorage: () => (state) => {
        apply(state?.theme ?? "dark");
      },
    },
  ),
);
