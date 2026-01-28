ALTER TABLE `openauth_webui_users` RENAME COLUMN "email" TO "identifier";--> statement-breakpoint
DROP INDEX `openauth_webui_users_email_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `openauth_webui_users_identifier_unique` ON `openauth_webui_users` (`identifier`);