import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { normalizeBasePath } from "./src/app/base-path";

const eventsPolyfill = fileURLToPath(new URL("./node_modules/events/events.js", import.meta.url));
const cryptoPolyfill = fileURLToPath(new URL("./src/shims/node-crypto.js", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");

  return {
    base: normalizeBasePath(environment.VITE_BASE_PATH),
    plugins: [react()],
    resolve: {
      alias: [
        { find: /^events$/, replacement: eventsPolyfill },
        { find: /^node:events$/, replacement: eventsPolyfill },
        { find: /^node:crypto$/, replacement: cryptoPolyfill }
      ]
    },
    optimizeDeps: {
      include: ["events"]
    },
    build: {
      sourcemap: true,
      target: "es2022"
    },
    test: {
      environment: "node",
      exclude: [...configDefaults.exclude, "e2e/**"]
    }
  };
});
