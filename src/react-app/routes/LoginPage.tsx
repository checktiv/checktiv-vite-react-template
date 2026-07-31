/**
 * What this teaches / copy this pattern:
 * The staff sign-in form for the mock auth gate (`src/worker/auth.ts` +
 * `lib/auth-client.ts`). It is intentionally unguarded and unshelled (no
 * `<GuardedRoute>`/`<AppShell>` - see the routing note in `main.tsx`) since it is
 * the page an unauthenticated visitor lands on. It carries the visible
 * "demo login, not production auth" notice so a deployer cannot mistake this gate
 * for real auth, and honors the `from` location `<GuardedRoute>` attaches when it
 * redirects here, so signing in returns the visitor to the page they wanted.
 */
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { login } from "../lib/auth-client";
import { Footer } from "../components/Footer";

interface LocationState {
	from?: string;
}

export default function LoginPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			await login(username, password);
			const from = (location.state as LocationState | null)?.from ?? "/reservations";
			navigate(from, { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Login failed. Try again.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="flex min-h-screen flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
			<div className="w-full max-w-sm rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
				<strong className="font-medium text-foreground">Demo login, not production auth.</strong>{" "}
				This is a shared, public demo credential with no real session security. Do not reuse this
				gate for a production login.
			</div>

			<form
				onSubmit={handleSubmit}
				className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 text-card-foreground"
			>
				<h1 className="text-lg font-semibold">Staff sign in</h1>

				<div className="space-y-1.5">
					<label htmlFor="username" className="text-sm font-medium">
						Username
					</label>
					<input
						id="username"
						name="username"
						autoComplete="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
						required
					/>
				</div>

				<div className="space-y-1.5">
					<label htmlFor="password" className="text-sm font-medium">
						Password
					</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
						required
					/>
				</div>

				{error ? <p className="text-sm text-destructive">{error}</p> : null}

				<button
					type="submit"
					disabled={submitting}
					className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
				>
					{submitting ? "Signing in..." : "Sign in"}
				</button>

				<p className="text-xs text-muted-foreground">Demo credentials: demo / demo</p>
			</form>
			</div>
			<Footer />
		</div>
	);
}
