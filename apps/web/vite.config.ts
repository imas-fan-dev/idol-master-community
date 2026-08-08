import { fileURLToPath } from "node:url"

import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

const honoOrigin = process.env.IMS_API_ORIGIN ?? "http://127.0.0.1:3000"
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".mjs"))
            ? "assets/[name]-[hash].js"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  plugins: [tailwindcss(), reactRouter()],
  optimizeDeps: {
    entries: ["app/**/*.{ts,tsx}"],
    include: [
      "@base-ui/react > use-sync-external-store/shim",
      "@base-ui/react > use-sync-external-store/shim/with-selector",
      "@tanstack/react-virtual",
    ],
    exclude: [
      "@base-ui/react/button",
      "@base-ui/react/dialog",
      "@base-ui/react/separator",
      "@base-ui/react/toggle",
      "@base-ui/react/toggle-group",
    ],
  },
  server: {
    fs: {
      allow: [workspaceRoot],
    },
    proxy: Object.fromEntries(
      [
        "/api",
        "/assets",
        "/css",
        "/Data",
        "/eventchronicle",
        "/icon",
        "/image",
        "/runninggame",
        "/site-content",
        "/sites",
        "/uploads",
      ].map((path) => [path, { target: honoOrigin, changeOrigin: false }])
    ),
  },
})
