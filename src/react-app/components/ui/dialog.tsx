/**
 * What this teaches / copy this pattern:
 * Hand-authored shadcn/ui "new-york" `Dialog` primitive family, wrapping
 * Radix's `@radix-ui/react-dialog` (focus trap, focus restore on close, body
 * scroll lock, portaling, `Escape`/overlay-click dismiss, and ARIA wiring all
 * come from Radix; this file only adds the shared visual treatment).
 * `BookingForm`'s "New booking" flow and the guest check-in page's fraud
 * consent gate both mount inside `DialogContent`.
 *
 * Use this rather than hand-rolling `role="dialog" aria-modal="true"`. That
 * attribute pair only redirects a screen reader's virtual cursor; it does
 * nothing for `Tab`, so a hand-rolled version leaves every control behind the
 * overlay reachable by keyboard, restores focus nowhere on close, and lets the
 * page scroll underneath on touch.
 *
 * A dialog that must NOT be dismissable (the applicant has to choose) is
 * expressible here without giving any of that up: pass
 * `onEscapeKeyDown` / `onPointerDownOutside` / `onInteractOutside` handlers
 * that `preventDefault()`, plus `showCloseButton={false}`. See
 * `CheckInPage.tsx`'s consent gate.
 */
import type * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { cn } from "../../lib/utils";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
	return (
		<DialogPrimitive.Overlay
			data-slot="dialog-overlay"
			className={cn(
				"fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
				className,
			)}
			{...props}
		/>
	);
}

function DialogContent({
	className,
	children,
	showCloseButton = true,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
	return (
		<DialogPortal>
			<DialogOverlay />
			{/*
			 * `max-h` + `overflow-y-auto` are NOT cosmetic and must not be dropped: a
			 * centered fixed box with neither one grows past the viewport and gets
			 * clipped at BOTH ends, with nothing to scroll. That makes a dialog whose
			 * content is taller than the viewport - a short phone in landscape, a raised
			 * OS text size, or the 200% zoom WCAG 1.4.4 requires - literally unreachable,
			 * including its buttons. It is a hard dead end for any dialog the user must
			 * answer to continue (the fraud consent gate on the guest check-in page is
			 * exactly that: it has no Escape and no backdrop dismiss by design).
			 */}
			<DialogPrimitive.Content
				data-slot="dialog-content"
				className={cn(
					"fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-w-lg",
					className,
				)}
				{...props}
			>
				{children}
				{showCloseButton && (
					<DialogPrimitive.Close
						data-slot="dialog-close"
						className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
					>
						<XIcon />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
			{...props}
		/>
	);
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
			{...props}
		/>
	);
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("text-lg leading-none font-semibold", className)}
			{...props}
		/>
	);
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
