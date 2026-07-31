/**
 * What this teaches / copy this pattern:
 * <BookingForm> collects the guest's first name, last name, and email as
 * DISTINCT fields - never a single combined "name" field. This is
 * load-bearing: it composes `guestName = `${firstName}
 * ${lastName}`` for the `NewReservation` record (whose type carries a
 * single `guestName`) AND passes the split `{ first_name, last_name, email }`
 * shape straight through to `checktivClient.createSession` (the wire
 * `applicant` shape). Collecting the split fields here means nothing later has
 * to re-split a joined name back apart.
 */
import { useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export interface BookingFormValues {
	firstName: string;
	lastName: string;
	email: string;
	property: string;
	/** ISO date string (YYYY-MM-DD). */
	checkIn: string;
	/** ISO date string (YYYY-MM-DD). */
	checkOut: string;
}

const EMPTY_VALUES: BookingFormValues = {
	firstName: "",
	lastName: "",
	email: "",
	property: "",
	checkIn: "",
	checkOut: "",
};

/**
 * A fixed set of dummy vacation-rental names. This is a demo PMS with no real
 * property inventory, so the "Property" field is a dropdown over these invented
 * names rather than free text. The selected value flows into `property`
 * (and the reservation record) exactly as the old text input did.
 */
const DEMO_PROPERTIES: readonly string[] = [
	"Harbor View - Unit 12",
	"Seaside Loft 3",
	"Downtown Studio 7",
	"Garden Cottage",
	"Skyline Suite 21",
	"Maple Ridge Cabin",
];

export function BookingForm({
	onSubmit,
	submitting = false,
}: {
	/** Receives the split field values as-is; the caller composes/derives anything joined. */
	onSubmit: (values: BookingFormValues) => void;
	submitting?: boolean;
}) {
	const [values, setValues] = useState<BookingFormValues>(EMPTY_VALUES);

	function setField<K extends keyof BookingFormValues>(key: K, value: BookingFormValues[K]) {
		setValues((prev) => ({ ...prev, [key]: value }));
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		onSubmit(values);
	}

	return (
		<form onSubmit={handleSubmit} className="grid gap-4">
			<div className="grid grid-cols-2 gap-4">
				<div className="grid gap-1.5">
					<Label htmlFor="firstName">First name</Label>
					<Input
						id="firstName"
						autoComplete="given-name"
						required
						value={values.firstName}
						onChange={(event) => setField("firstName", event.target.value)}
					/>
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor="lastName">Last name</Label>
					<Input
						id="lastName"
						autoComplete="family-name"
						required
						value={values.lastName}
						onChange={(event) => setField("lastName", event.target.value)}
					/>
				</div>
			</div>

			<div className="grid gap-1.5">
				<Label htmlFor="email">Email</Label>
				<Input
					id="email"
					type="email"
					autoComplete="email"
					required
					value={values.email}
					onChange={(event) => setField("email", event.target.value)}
				/>
			</div>

			<div className="grid gap-1.5">
				<Label htmlFor="property">Property</Label>
				<select
					id="property"
					required
					value={values.property}
					onChange={(event) => setField("property", event.target.value)}
					className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
				>
					<option value="" disabled>
						Select a property
					</option>
					{DEMO_PROPERTIES.map((property) => (
						<option key={property} value={property}>
							{property}
						</option>
					))}
				</select>
			</div>

			<div className="grid grid-cols-2 gap-4">
				<div className="grid gap-1.5">
					<Label htmlFor="checkIn">Check-in</Label>
					<Input
						id="checkIn"
						type="date"
						required
						value={values.checkIn}
						onChange={(event) => setField("checkIn", event.target.value)}
					/>
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor="checkOut">Check-out</Label>
					<Input
						id="checkOut"
						type="date"
						required
						value={values.checkOut}
						onChange={(event) => setField("checkOut", event.target.value)}
					/>
				</div>
			</div>

			<Button type="submit" disabled={submitting}>
				{submitting ? "Creating..." : "Create booking"}
			</Button>
		</form>
	);
}
