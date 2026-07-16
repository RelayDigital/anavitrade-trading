import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@/_core": path.resolve(import.meta.dirname, "src/_core"),
    },
  },
  server: {
    host: true,
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "https://anavitrade-trading.erhazeariel.workers.dev",
        changeOrigin: true,
        rewrite: (path) => path,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          wagmi: ["wagmi", "viem"],
          recharts: ["recharts"],
          framer: ["framer-motion"],
        },
      },
    },
  },
});
