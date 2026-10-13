import { useQuery } from "@tanstack/react-query";
import { AUTH_CONFIG_FALLBACK, fetchAuthConfig, type AuthConfig } from "@/services/auth-config";

/**
 * What this hub accepts at sign-in. Never suspends and never fails: until the
 * hub answers, the password form is shown, so a slow or missing /auth/config
 * cannot leave the login page blank.
 */
export const useAuthConfig = (): AuthConfig => {
  const { data } = useQuery({ queryKey: ["auth-config"], queryFn: fetchAuthConfig, staleTime: Infinity });

  return data ?? AUTH_CONFIG_FALLBACK;
};
