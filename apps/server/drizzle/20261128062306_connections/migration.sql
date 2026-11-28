CREATE TABLE `connections` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`vault_item_id` text,
	`owner` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`level` text NOT NULL,
	`verified_at` text,
	`last_check_at` text,
	`last_check_ok` integer,
	`last_check_message` text,
	`models` text DEFAULT '[]' NOT NULL,
	`manual_models` text DEFAULT '[]' NOT NULL
);
