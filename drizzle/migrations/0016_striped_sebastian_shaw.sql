CREATE TABLE `openauth_webui_ui_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`from_user_id` text NOT NULL,
	`from_user_name` text NOT NULL,
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`type` text NOT NULL,
	`owner_group_id` text NOT NULL,
	`expiresAt` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `openauth_webui_copy_template_invites`;--> statement-breakpoint
DROP TABLE `openauth_webui_email_template_invites`;--> statement-breakpoint
DROP TABLE `openauth_webui_project_invites`;