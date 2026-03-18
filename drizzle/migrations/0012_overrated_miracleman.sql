ALTER TABLE `openauth_webui_copy_templates` RENAME COLUMN "owner" TO "owner_id";--> statement-breakpoint
ALTER TABLE `openauth_webui_email_templates` RENAME COLUMN "owner" TO "owner_id";--> statement-breakpoint
ALTER TABLE `openauth_webui_ui_styles` RENAME COLUMN "owner" TO "owner_id";--> statement-breakpoint
ALTER TABLE `openauth_webui_copy_templates` ADD `owner_group_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `openauth_webui_email_templates` ADD `owner_group_id` text NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_projects` (
	`clientID` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`owner_group_id` text NOT NULL,
	`active` integer DEFAULT true,
	`providers_data` text DEFAULT '[]',
	`theme_id` integer,
	`codeMode` text,
	`emailTemplateId` text,
	`projectData` text DEFAULT '{}',
	`registerOnInvite` integer DEFAULT false,
	`originURL` text,
	`secret` text NOT NULL,
	`authEndpointURL` text NOT NULL,
	`cloudflareDomaineID` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`theme_id`) REFERENCES `openauth_webui_ui_styles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_projects`("clientID", "owner_id", "owner_group_id", "active", "providers_data", "theme_id", "codeMode", "emailTemplateId", "projectData", "registerOnInvite", "originURL", "secret", "authEndpointURL", "cloudflareDomaineID", "created_at") SELECT "clientID", "owner_id", "owner_group_id", "active", "providers_data", "theme_id", "codeMode", "emailTemplateId", "projectData", "registerOnInvite", "originURL", "secret", "authEndpointURL", "cloudflareDomaineID", "created_at" FROM `openauth_webui_projects`;--> statement-breakpoint
DROP TABLE `openauth_webui_projects`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_projects` RENAME TO `openauth_webui_projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `openauth_webui_users` ADD `role` text;