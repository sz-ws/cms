CREATE TABLE `contents` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`slug` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contents_type_slug` ON `contents` (`type`,`slug`) WHERE "contents"."slug" is not null;--> statement-breakpoint
CREATE INDEX `contents_type_updated` ON `contents` (`type`,`updated_at`);--> statement-breakpoint
CREATE TABLE `declarative_extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`version` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`source` text,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
