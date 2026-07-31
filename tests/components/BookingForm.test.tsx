// @vitest-environment happy-dom
/**
 * What this teaches / copy this pattern:
 * <BookingForm> collects split guest fields plus a PROPERTY chosen from a fixed
 * dummy dropdown (this demo has no real inventory). These tests render the real
 * component (happy-dom + @testing-library) and prove (a) the property field is a
 * `<select>` populated with the dummy names and defaults to an unselected
 * placeholder, and (b) the selected property flows into the `onSubmit` values
 * unchanged - exactly as the old free-text input did.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BookingForm, type BookingFormValues } from "../../src/react-app/components/BookingForm";

describe("BookingForm property dropdown", () => {
	// No `globals: true`, so RTL auto-cleanup is not wired - unmount explicitly.
	afterEach(() => {
		cleanup();
	});

	it("renders the property field as a select with the dummy set and a placeholder default", () => {
		render(<BookingForm onSubmit={vi.fn()} />);
		const select = screen.getByLabelText(/property/i);
		expect(select.tagName).toBe("SELECT");
		// A disabled placeholder option is present (the unselected default).
		expect(screen.getByRole("option", { name: /select a property/i })).toBeInTheDocument();
		// A few of the invented vacation-rental names are present.
		expect(screen.getByRole("option", { name: "Harbor View - Unit 12" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Skyline Suite 21" })).toBeInTheDocument();
	});

	it("flows the selected property into the onSubmit values", () => {
		const onSubmit = vi.fn<(values: BookingFormValues) => void>();
		render(<BookingForm onSubmit={onSubmit} />);

		fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: "Ada" } });
		fireEvent.change(screen.getByLabelText(/last name/i), { target: { value: "Lovelace" } });
		fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "ada@example.co" } });
		fireEvent.change(screen.getByLabelText(/property/i), {
			target: { value: "Downtown Studio 7" },
		});
		fireEvent.change(screen.getByLabelText(/check-in/i), { target: { value: "2026-08-01" } });
		fireEvent.change(screen.getByLabelText(/check-out/i), { target: { value: "2026-08-05" } });
		fireEvent.click(screen.getByRole("button", { name: /create booking/i }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				firstName: "Ada",
				lastName: "Lovelace",
				email: "ada@example.co",
				property: "Downtown Studio 7",
				checkIn: "2026-08-01",
				checkOut: "2026-08-05",
			}),
		);
	});
});
