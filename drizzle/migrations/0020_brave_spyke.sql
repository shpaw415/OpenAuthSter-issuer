PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_openauth_webui_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`clientID` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`context` text,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_openauth_webui_logs`("id", "clientID", "type", "message", "context", "timestamp") SELECT "id", "clientID", "type", "message", "context", "timestamp" FROM `openauth_webui_logs`;--> statement-breakpoint
DROP TABLE `openauth_webui_logs`;--> statement-breakpoint
ALTER TABLE `__new_openauth_webui_logs` RENAME TO `openauth_webui_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;