CREATE TABLE `provider_backoffs` (
	`provider` text PRIMARY KEY,
	`reason` text NOT NULL,
	`signin` integer DEFAULT false NOT NULL,
	`until` text NOT NULL,
	`login` text,
	`failed_at` text NOT NULL
);
