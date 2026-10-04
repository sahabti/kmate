/** Which Realm View art theme the user prefers. Persisted per browser. */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface RealmThemeState {
  /** Empty means "whatever the build says is the default". */
  themeId: string;
  setTheme: (id: string) => void;
}

export const useRealmTheme = create<RealmThemeState>()(
  persist(
    (set) => ({
      themeId: "",
      setTheme: (id) => set({ themeId: id }),
    }),
    { name: "kmate.realmTheme" },
  ),
);
