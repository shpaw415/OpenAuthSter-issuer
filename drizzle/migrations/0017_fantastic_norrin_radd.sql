ALTER TABLE `openauth_webui_ui_invites` RENAME COLUMN "expiresAt" TO "expires_at";--> statement-breakpoint
ALTER TABLE `openauth_webui_ui_invites` ADD `status` text DEFAULT 'pending';