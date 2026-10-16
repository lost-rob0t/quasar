import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^node:crypto$/,
        replacement: fileURLToPath(new URL("../../../src/shims/node-crypto.js", import.meta.url))
      },
      { find: /^\.\.\/store$/, replacement: fileURLToPath(new URL("./store.js", import.meta.url)) }
    ]
  },
  server: { host: "127.0.0.1", port: 5190, strictPort: true }
});
