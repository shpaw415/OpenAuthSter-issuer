CREATE TABLE `openauth_webui_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`event` text NOT NULL,
	`url` text NOT NULL,
	`method` text NOT NULL,
	`headers` text,
	`created_at` text NOT NULL
);
