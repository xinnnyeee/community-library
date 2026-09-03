import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, loadEnv } from "vite";

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), cloudflare(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@shared": path.resolve(__dirname, "./shared"),
      },
    },
    server: {
      // Bind to 0.0.0.0 (not just localhost) so phones on the same Wi-Fi can
      // reach the dev server, e.g. to use the camera on /admin/add-book.
      host: true,
      // DEV_HOST (used for the Cloudflare Tunnel / Telegram bot setup) stays
      // allowed when set; otherwise allow any host so LAN IP access works.
      allowedHosts: env.DEV_HOST ? [env.DEV_HOST] : true,
    },
  };
});
