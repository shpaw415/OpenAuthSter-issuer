CREATE TABLE `openauth_webui_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `openauth_webui_invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`link` text NOT NULL,
	`expiresAt` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `openauth_webui_projects` ADD `registerOnInvite` integer DEFAULT false;