import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

/// <reference types="vitest/config" />
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    // Bind to every interface: "localhost" alone can resolve to only ::1 on macOS,
    // which makes http://127.0.0.1:5173 unreachable. This also exposes the dev
    // server on the LAN so a phone on the same Wi-Fi can open it.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/kmate.v1.": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8080", ws: true, changeOrigin: true },
      "/pf": { target: "http://127.0.0.1:8080", changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          router: ["@tanstack/react-router", "@tanstack/react-query"],
          connect: ["@connectrpc/connect", "@connectrpc/connect-web", "@bufbuild/protobuf"],
        },
      },
    },
  },
});
