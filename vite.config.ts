/**
 * What this teaches / copy this pattern:
 * A single Vite config drives both the React SPA and the Cloudflare Worker that
 * serves it. Order matters: `@tailwindcss/vite` and `@vitejs/plugin-react` handle
 * the client build, and `cloudflare()` wires the Worker + its bindings into the
 * same dev server so `/api/*` and the SPA share one origin (the same-origin proxy
 * posture the Checktiv integration relies on).
 *
 * - `server.port = 3000` is load-bearing: local dev runs behind a *named*
 *   cloudflared tunnel whose registered origin maps to `localhost:3000`. Checktiv
 *   live keys are origin-pinned, so the port must match the registered origin.
 * - `server.allowedHosts` is ALSO load-bearing, and easy to miss: Vite's DNS
 *   rebinding guard 403s any request whose Host header is not `localhost` (verified
 *   live - the tunnel origin below 403'd with "Blocked request" before this entry
 *   was added), so the registered tunnel hostname must be listed explicitly here.
 *   `your-tunnel.example.com` is a placeholder: replace it with your own public
 *   tunnel/host. If you register a stable hostname for your own tunnel, add it
 *   here, or the tunnel will 403 before your key's origin pinning is even checked.
 * - The `@` alias points at `src/react-app` so shadcn/ui imports (`@/components`,
 *   `@/lib/utils`) resolve. It mirrors the `paths` entry in `tsconfig.app.json`.
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
	plugins: [react(), tailwindcss(), cloudflare()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src/react-app", import.meta.url)),
		},
	},
	server: {
		port: 3000,
		// Replace with your own public tunnel/host (see the note above).
		allowedHosts: ["your-tunnel.example.com"],
	},
});
