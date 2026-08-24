/**
 * What this teaches / copy this pattern:
 * Hand-authored shadcn/ui "new-york" `Select` primitive - a NATIVE `<select>`
 * carrying the same focus/invalid/disabled treatment as `Input`, so a dropdown
 * and a text box read as the same control family.
 *
 * Native on purpose, not for lack of ambition. A native `<select>` is keyboard
 * operable and type-ahead searchable with no code, it is announced correctly by
 * every screen reader, and on a phone it opens the platform's own full-height
 * picker - which is what makes a 248-entry country list usable at 390px, where a
 * custom listbox would be a scrolling popover the size of a postage stamp. It also
 * keeps this demo dependency-light: a headless select component would be another
 * package for a sample app to justify.
 *
 * The one thing it costs is styling control over the open menu, which no amount of
 * CSS gets back. That is a fair trade for a list nobody needs branded.
 */
import type * as React from "react";
import { cn } from "../../lib/utils";

function Select({ className, children, ...props }: React.ComponentProps<"select">) {
	return (
		<select
			data-slot="select"
			className={cn(
				// `h-9` and the border/focus treatment are copied from `Input` rather than
				// shared, because the two primitives are allowed to diverge; if they ever
				// need to move together, extract the string then, not before.
				"flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
				"focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				"aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		>
			{children}
		</select>
	);
}

export { Select };
