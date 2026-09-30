/**
 * Platform abstraction. The web implementation is the default; Tauri shells
 * replace `platform` at startup with native implementations (keychain, shell open).
 */
export interface Platform {
  name: "web" | "desktop" | "mobile";
  openExternal(url: string): void;
  storeToken(token: string | null): void;
  loadToken(): string | null;
  hubUrl(): string;
}

const SESSION_KEY = "kmate.session";

const web: Platform = {
  name: "web",
  openExternal(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  storeToken(token) {
    try {
      if (token) localStorage.setItem(SESSION_KEY + ".token", token);
      else localStorage.removeItem(SESSION_KEY + ".token");
    } catch {
      /* storage unavailable */
    }
  },
  loadToken() {
    try {
      return localStorage.getItem(SESSION_KEY + ".token");
    } catch {
      return null;
    }
  },
  hubUrl() {
    return window.location.origin;
  },
};

export let platform: Platform = web;
export function setPlatform(p: Platform) {
  platform = p;
}
