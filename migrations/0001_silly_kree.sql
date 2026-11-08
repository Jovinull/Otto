CREATE TABLE `lease_guard` (
	`event_id` text NOT NULL,
	`reason` text NOT NULL,
	CONSTRAINT "lease_guard_owner_only" CHECK("lease_guard"."reason" = 'never')
);
--> statement-breakpoint
ALTER TABLE `incoming_events` ADD `lease_token` text;--> statement-breakpoint
CREATE INDEX `event_lane_idx` ON `incoming_events` (`chat_id`,`update_id`);