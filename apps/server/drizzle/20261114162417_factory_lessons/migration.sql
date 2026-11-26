CREATE TABLE `factory_lessons` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`lesson` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`removed_at` text
);
--> statement-breakpoint
CREATE INDEX `factory_lessons_project_key` ON `factory_lessons` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `factory_lessons_project_seen` ON `factory_lessons` (`project_id`,`last_seen_at`);