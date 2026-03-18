CREATE TABLE `openauth_webui_copy_template_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`clientID` text NOT NULL,
	`code` text NOT NULL,
	`expiresAt` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `openauth_webui_email_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `openauth_webui_email_template_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`clientID` text NOT NULL,
	`code` text NOT NULL,
	`expiresAt` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `openauth_webui_email_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `openauth_webui_project_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`expiresAt` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`context` text,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_logs`("id", "clientID", "type", "message", "context", "timestamp") SELECT "id", "clientID", "type", "message", "context", "timestamp" FROM `openauth_webui_logs`;--> statement-breakpoint
DROP TABLE `openauth_webui_logs`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_logs` RENAME TO `openauth_webui_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`event` text NOT NULL,
	`url` text NOT NULL,
	`method` text NOT NULL,
	`headers` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_webhooks`("id", "clientID", "event", "url", "method", "headers", "created_at") SELECT "id", "clientID", "event", "url", "method", "headers", "created_at" FROM `openauth_webui_webhooks`;--> statement-breakpoint
DROP TABLE `openauth_webui_webhooks`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_webhooks` RENAME TO `openauth_webui_webhooks`;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`link` text NOT NULL,
	`expiresAt` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_invite_links`("id", "clientID", "link", "expiresAt", "created_at") SELECT "id", "clientID", "link", "expiresAt", "created_at" FROM `openauth_webui_invite_links`;--> statement-breakpoint
DROP TABLE `openauth_webui_invite_links`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_invite_links` RENAME TO `openauth_webui_invite_links`;--> statement-breakpoint
CREATE TABLE `__new_openauth_totp` (
	`user_id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`secret` text NOT NULL,
	`is_verified` integer DEFAULT false,
	`backup_codes` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_openauth_totp`("user_id", "clientID", "secret", "is_verified", "backup_codes", "created_at") SELECT "user_id", "clientID", "secret", "is_verified", "backup_codes", "created_at" FROM `openauth_totp`;--> statement-breakpoint
DROP TABLE `openauth_totp`;--> statement-breakpoint
ALTER TABLE `__new_openauth_totp` RENAME TO `openauth_totp`;--> statement-breakpoint
CREATE TABLE `__new_openauth_totp_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`clientID` text NOT NULL,
	`token_expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`clientID`) REFERENCES `openauth_webui_projects`(`clientID`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_openauth_totp_tokens`("token", "user_id", "clientID", "token_expires_at", "created_at") SELECT "token", "user_id", "clientID", "token_expires_at", "created_at" FROM `openauth_totp_tokens`;--> statement-breakpoint
DROP TABLE `openauth_totp_tokens`;--> statement-breakpoint
ALTER TABLE `__new_openauth_totp_tokens` RENAME TO `openauth_totp_tokens`;