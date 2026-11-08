CREATE TABLE `onboarding_sessions` (
	`household_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`conductor_member_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conductor_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action
);
