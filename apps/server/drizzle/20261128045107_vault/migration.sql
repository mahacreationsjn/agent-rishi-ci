CREATE TABLE `vault_audit` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`item_id` text NOT NULL,
	`item_name` text NOT NULL,
	`grant_id` text,
	`session_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `vault_grants` (
	`id` text PRIMARY KEY,
	`item_id` text NOT NULL,
	`role` text,
	`project_id` text,
	`destination` text,
	`expires_at` text,
	`owner` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_vault_grants_item_id_vault_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `vault_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_items` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`scope` text NOT NULL,
	`provider` text,
	`env_name` text,
	`sealed` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `vault_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vault_audit_item` ON `vault_audit` (`item_id`,`seq`);--> statement-breakpoint
CREATE INDEX `vault_grants_item` ON `vault_grants` (`item_id`);