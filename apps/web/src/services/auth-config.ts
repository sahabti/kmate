/**
 * The unauthenticated half of the sign-in handshake with the hub: what it will
 * accept, and how it hands a session back after an external login.
 */

export interface AuthConfig {
  localLogin: boolean;
  oidc: { enabled: boolean; label?: string; loginUrl?: string };
}

/** An older hub has no /auth/config, and must still be usable with a password. */
export const AUTH_CONFIG_FALLBACK: AuthConfig = { localLogin: true, oidc: { enabled: false } };

/** Served unauthenticated so the login page can decide what to render. */
export const fetchAuthConfig = async (): Promise<AuthConfig> => {
  try {
    const res = await fetch("/auth/config", { cache: "no-store" });
    if (!res.ok) return AUTH_CONFIG_FALLBACK;
    const cfg = (await res.json()) as Partial<AuthConfig>;

    // Never report "no way to sign in": a malformed response must still leave
    // the password form on screen rather than locking everyone out.
    return {
      localLogin: cfg.localLogin ?? !cfg.oidc?.enabled,
      oidc: { enabled: !!cfg.oidc?.enabled, label: cfg.oidc?.label, loginUrl: cfg.oidc?.loginUrl ?? "/auth/oidc/login" },
    };
  } catch {
    return AUTH_CONFIG_FALLBACK;
  }
};

/**
 * The hub finishes an OIDC login by redirecting back with the session token in
 * the URL *fragment*, which browsers never send upstream and gateways do not
 * log. Returns the token and strips it from the address bar so it is not left
 * in history or copied out of the URL bar.
 */
export const takeTokenFromFragment = (): string | null => {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return null;
  const token = new URLSearchParams(hash.slice(1)).get("token");
  if (!token) return null;
  const clean = window.location.pathname + window.location.search;
  window.history.replaceState(null, "", clean || "/");

  return token;
};
