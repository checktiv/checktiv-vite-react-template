/**
 * What this teaches / copy this pattern:
 * The staff sidebar nav. "Reservations" is the only section this demo
 * actually implements, so it is a real `NavLink`. "Properties" and
 * "Settings" are rendered as decorative, visually-disabled rows purely so
 * the shell reads as a real PMS - they intentionally do NOT navigate
 * anywhere, since a link to a route this demo never built would be a dead
 * end (the self-serve rule: never ship a control that leads nowhere).
 */
import { NavLink } from "react-router";
import { Building2Icon, CalendarCheckIcon, SettingsIcon } from "lucide-react";
import { cn } from "../lib/utils";

const NAV_ITEM_CLASS = "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors";

/** A sidebar row for a section this demo has not built - visible, but inert on purpose. */
function DecorativeNavItem({ icon: Icon, label }: { icon: typeof Building2Icon; label: string }) {
	return (
		<div
			className={cn(NAV_ITEM_CLASS, "cursor-not-allowed text-sidebar-foreground/40")}
			aria-disabled="true"
			title="Not part of this demo"
		>
			<Icon className="size-4" />
			{label}
		</div>
	);
}

export function Sidebar() {
	return (
		<nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3">
			<NavLink
				to="/reservations"
				className={({ isActive }) =>
					cn(
						NAV_ITEM_CLASS,
						"text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
						isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
					)
				}
			>
				<CalendarCheckIcon className="size-4" />
				Reservations
			</NavLink>
			<DecorativeNavItem icon={Building2Icon} label="Properties" />
			<DecorativeNavItem icon={SettingsIcon} label="Settings" />
		</nav>
	);
}
