-- Migration number: 0001 	 2026-07-27T00:00:00.000Z
CREATE TABLE IF NOT EXISTS reservations (
	id TEXT PRIMARY KEY,
	guest_name TEXT NOT NULL,
	guest_email TEXT NOT NULL,
	property TEXT NOT NULL,
	check_in TEXT NOT NULL,
	check_out TEXT NOT NULL,
	session_id TEXT,
	status TEXT NOT NULL
);
