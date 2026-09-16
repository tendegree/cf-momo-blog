import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 前端构建到 dist/client，供 [assets] 托管
export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    // 本地开发：/api 转发给 wrangler dev（4318）
    proxy: { "/api": { target: "http://127.0.0.1:4318", changeOrigin: false } },
  },
  build: { outDir: "../dist/client", emptyOutDir: true },
});