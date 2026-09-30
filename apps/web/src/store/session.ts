import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User } from "@/gen/kmate/v1/hub_pb";
import { platform } from "@/platform";

interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface SessionState {
  token: string | null;
  user: SessionUser | null;
  setSession(token: string, user: User): void;
  clear(): void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      token: platform.loadToken(),
      user: null,
      setSession(token, user) {
        platform.storeToken(token);
        set({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
      },
      clear() {
        platform.storeToken(null);
        set({ token: null, user: null });
      },
    }),
    {
      name: "kmate.session",
      partialize: (s) => ({ user: s.user, token: s.token }),
    },
  ),
);
