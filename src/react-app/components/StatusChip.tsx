/**
 * What this teaches / copy this pattern:
 * <StatusChip> reduces the demo's own 4-member `Reservation["status"]` to a
 * label + color chip. The `satisfies Record<Reservation["status"], …>` map
 * below is the compile-time guard: add a 5th reservation status and this
 * file fails `tsc -b` until it is added here too, so a new status can never
 * be silently under-handled (see tests/components/StatusChip.test.tsx for
 * the runtime backstop over the same 4 values).
 *
 * Scope note: this component ONLY ever receives `Reservation["status"]`
 * (draft | invited | verifying | complete). Checktiv's own live session
 * carries a separate, 11-member `SessionStatus` - the reservation detail
 * page (src/react-app/routes/ReservationDetailPage.tsx) reduces a live
 * session status down to a `Reservation["status"]` via
 * `src/shared/session-status.ts` BEFORE it ever reaches this component. Do
 * not widen the map below to accept the session enum directly.
 */
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import type { Reservation } from "../../shared/reservation-types";

type Status = Reservation["status"];

const STATUS_META = {
	draft: {
		label: "Draft",
		className: "text-muted-foreground",
	},
	invited: {
		label: "Invited",
		className:
			"border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
	},
	verifying: {
		label: "Verifying",
		className:
			"border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
	},
	complete: {
		label: "Complete",
		className:
			"border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
	},
} satisfies Record<Status, { label: string; className: string }>;

/** Renders a reservation's lifecycle status (never a raw Checktiv session status) as a small colored chip. */
export function StatusChip({ status }: { status: Status }) {
	const { label, className } = STATUS_META[status];
	return (
		<Badge variant="outline" className={cn(className)}>
			{label}
		</Badge>
	);
}
