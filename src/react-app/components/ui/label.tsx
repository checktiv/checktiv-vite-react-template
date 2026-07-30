/**
 * What this teaches / copy this pattern:
 * Hand-authored shadcn/ui "new-york" `Label` primitive, wrapping Radix's
 * accessible `Label.Root` (click-to-focus the associated control, proper
 * `for`/`id` semantics) with the shared typography treatment.
 */
import type * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../../lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
	return (
		<LabelPrimitive.Root
			data-slot="label"
			className={cn(
				"flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export { Label };
