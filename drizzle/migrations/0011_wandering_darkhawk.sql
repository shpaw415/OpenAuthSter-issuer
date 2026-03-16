PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_copy_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`copyData` text NOT NULL,
	`owner` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_copy_templates`("id", "name", "copyData", "owner", "created_at", "updated_at") SELECT "id", "name", "copyData", "owner", "created_at", "updated_at" FROM `openauth_webui_copy_templates`;--> statement-breakpoint
DROP TABLE `openauth_webui_copy_templates`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_copy_templates` RENAME TO `openauth_webui_copy_templates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_email_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`subject` text NOT NULL,
	`owner` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_email_templates`("id", "name", "body", "subject", "owner", "created_at", "updated_at") SELECT "id", "name", "body", "subject", "owner", "created_at", "updated_at" FROM `openauth_webui_email_templates`;--> statement-breakpoint
DROP TABLE `openauth_webui_email_templates`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_email_templates` RENAME TO `openauth_webui_email_templates`;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_ui_styles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`themeData` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_ui_styles`("id", "name", "owner", "themeData") SELECT "id", "name", "owner", "themeData" FROM `openauth_webui_ui_styles`;--> statement-breakpoint
DROP TABLE `openauth_webui_ui_styles`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_ui_styles` RENAME TO `openauth_webui_ui_styles`;