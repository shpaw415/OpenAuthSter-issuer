CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`clientID` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`clientID` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text,
	`backed_up` integer DEFAULT false,
	`transports` text,
	`created_at` text NOT NULL
);
