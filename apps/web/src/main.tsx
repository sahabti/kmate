import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { denialFromError } from "@/lib/denial";
import { RouterProvider } from "@tanstack/react-router";
import "@/index.css";
import { router } from "@/router";
import { useTheme } from "@/stores/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/confirm";
import { Toaster } from "@/components/ui/sonner";
import { hub } from "@/services/api-client";
import { takeTokenFromFragment } from "@/services/auth-config";
import { useSession } from "@/stores/session";

// Apply persisted theme before first paint.
document.documentElement.classList.toggle("dark", useTheme.getState().theme === "dark");

// An OIDC sign-in lands back on any app route with the session token in the URL
// fragment. Claim it before the router mounts so the first render is already
// past the auth guard and nobody sees a flash of the login page. The profile
// arrives a moment later; the token alone is what the guard checks.
const oidcToken = takeTokenFromFragment();
if (oidcToken) {
  useSession.setState({ token: oidcToken });
  void hub
    .me({})
    .then((r) => r.user && useSession.getState().setSession(oidcToken, r.user))
    .catch(() => useSession.getState().clear());
}

// A permission denial is a final answer: retrying or polling it only produces
// console noise and load, so queries stop as soon as the hub or the API server
// says no.
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, err) => !denialFromError(err) && count < 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={300}>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
        <Toaster position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
