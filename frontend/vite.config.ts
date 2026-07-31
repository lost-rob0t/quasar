import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadEnv } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { normalizeBasePath } from "./src/app/base-path";

const require = createRequire(import.meta.url);
const eventsPolyfill = require.resolve("events/events.js");
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
