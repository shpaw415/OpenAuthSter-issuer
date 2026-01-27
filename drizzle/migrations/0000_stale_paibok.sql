CREATE TABLE `openauth_webui_copy_templates` (
	`name` text PRIMARY KEY NOT NULL,
	`providerType` text NOT NULL,
	`copyData` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `openauth_webui_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `openauth_webui_users_email_unique` ON `openauth_webui_users` (`email`);--> statement-breakpoint
CREATE TABLE `openauth_webui_email_templates` (
	`name` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `openauth_webui_projects` (
	`clientID` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`active` integer DEFAULT true,
	`providers_data` text DEFAULT '[]',
	`themeId` text,
	`codeMode` text,
	`emailTemplateId` text,
	`projectData` text DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE `openauth_webui_ui_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`themeData` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `openauth_webui` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expiry` integer
);
