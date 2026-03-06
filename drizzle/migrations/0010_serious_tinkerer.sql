CREATE TABLE `webauthn_token_access` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`clientID` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `webauthn_challenges` DROP COLUMN `user_id`;