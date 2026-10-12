import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { denialFromError } from "@/lib/denial";
import { RouterProvider } from "@tanstack/react-router";
import "./index.css";
import { router } from "./router";
import { useTheme } from "./store/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/confirm";
import { Toaster } from "@/components/ui/sonner";

// Apply persisted theme before first paint.
document.documentElement.classList.toggle("dark", useTheme.getState().theme === "dark");

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
