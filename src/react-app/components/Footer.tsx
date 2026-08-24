/**
 * What this teaches / copy this pattern:
 * ONE reusable footer rendered on EVERY page - both the staff-shelled pages
 * (via `AppShell`) and the unshelled Setup / guest Check-in pages. It
 * makes it unmistakable that this minimalist PMS is a Checktiv INTEGRATION DEMO
 * and links out to the product, the docs, and the template's source on GitHub.
 *
 * Placement contract (why this is a plain block, not `position: fixed`): each
 * host page is a `min-h-screen`/`min-h-svh` flex COLUMN whose content area is
 * `flex-1`, so this footer sits at the bottom of the viewport when content is
 * short and below the content when it scrolls - the classic "sticky footer"
 * layout. A `fixed` footer would overlap the guest Check-in page's SDK mount
 * target (the IDV capture area can be 600px+ tall); keeping it in normal flow
 * guarantees it never covers the mounted flow.
 *
 * External links open in a new tab and carry `rel="noopener noreferrer"` so the
 * opened page cannot reach back into this one via `window.opener`.
 */

/** A single external footer link: new tab, opener-isolated, subtly underlined. */
function FooterLink({ href, children }: { href: string; children: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="underline underline-offset-2 hover:text-foreground"
		>
			{children}
		</a>
	);
}

/** The app-wide demo footer. Include it once per page (see the placement contract above). */
export function Footer() {
	return (
		<footer className="border-t border-border bg-background/80 px-4 py-3 text-center text-xs text-muted-foreground">
			<span className="font-medium text-foreground">Demo app.</span> A sample
			property-management app showing the Checktiv identity-verification integration.{" "}
			<FooterLink href="https://checktiv.com">Checktiv</FooterLink>
			{" · "}
			<FooterLink href="https://docs.checktiv.com">Documentation</FooterLink>
			{" · "}
			<FooterLink href="https://github.com/checktiv/checktiv-vite-react-template">
				GitHub
			</FooterLink>
		</footer>
	);
}
