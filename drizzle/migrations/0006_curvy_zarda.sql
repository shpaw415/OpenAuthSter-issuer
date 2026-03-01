CREATE TABLE `openauth_totp` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`is_verified` integer DEFAULT false,
	`token` text,
	`token_expires_at` text,
	`backup_codes` text NOT NULL,
	`created_at` text NOT NULL
);
