CREATE TABLE `qr_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `books` ADD `category` text;