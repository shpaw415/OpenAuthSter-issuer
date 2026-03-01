CREATE TABLE `openauth_totp_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`clientID` text NOT NULL,
	`token_expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `openauth_totp` DROP COLUMN `token`;--> statement-breakpoint
ALTER TABLE `openauth_totp` DROP COLUMN `token_expires_at`;