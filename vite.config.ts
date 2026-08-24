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
 * - The `@` alias points at `src/react-app` so shadcn/ui imports (`@/components`,
 *   `@/lib/utils`) resolve. It mirrors the `paths` entry in `tsconfig.app.json`.
 *
 * WHY THE TUNNEL HOST COMES FROM ENV RATHER THAN A LITERAL HERE. This file is
 * tracked, so hardcoding a real tunnel hostname means editing a tracked file every
 * time you develop - and a tracked file edited for local convenience is exactly the
 * thing that rides along into a commit. That has already happened in this repo with
 * the dev-cell flag in `.env`. So the host is read from `DEV_TUNNEL_HOST` in the
 * GITIGNORED `.env.local`, which git structurally cannot publish:
 *
 *   DEV_TUNNEL_HOST=your-tunnel.example.com
 *
 * With it unset, the committed placeholder stands - the dev server still runs on
 * `localhost`, and only the tunnel hostname is unrecognized. `loadEnv`'s third
 * argument is `""` so a NON-`VITE_`-prefixed name is readable here; that also keeps
 * it out of the client bundle, which is correct - it is a dev-server setting, not
 * something the browser needs.
 */
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, ROOT, "");
	const tunnelHost = env.DEV_TUNNEL_HOST?.trim();

	return {
		plugins: [react(), tailwindcss(), cloudflare()],
		resolve: {
			alias: {
				"@": fileURLToPath(new URL("./src/react-app", import.meta.url)),
			},
		},
		server: {
			port: 3000,
			// Set DEV_TUNNEL_HOST in the gitignored `.env.local` (see the note above).
			// The placeholder is what a reader sees, and is inert until replaced.
			allowedHosts: [tunnelHost && tunnelHost.length > 0 ? tunnelHost : "your-tunnel.example.com"],
		},
	};
});
