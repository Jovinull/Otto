CREATE TABLE `balance_reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`reference_date` text NOT NULL,
	`calculated_cents` integer NOT NULL,
	`reported_cents` integer NOT NULL,
	`difference_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`member_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `financial_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_reconciliations_idempotency_key_unique` ON `balance_reconciliations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `reconciliation_account_idx` ON `balance_reconciliations` (`account_id`,`status`);--> statement-breakpoint
DROP INDEX `account_household_name_uq`;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `ownership` text DEFAULT 'unassigned' NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `institution` text;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `description` text;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `opening_balance_date` text;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `shared_fallback` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `credit_limit_cents` integer;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `credit_available_cents` integer;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `credit_available_date` text;--> statement-breakpoint
ALTER TABLE `financial_accounts` ADD `identity_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Dados existentes: dono explicito quando conhecido; conta conjunta e do casal; o resto fica sem dono.
UPDATE `financial_accounts` SET `ownership` = CASE WHEN `owner_member_id` IS NOT NULL THEN 'member' WHEN `kind` = 'joint' THEN 'shared' ELSE 'unassigned' END;--> statement-breakpoint
UPDATE `financial_accounts` SET `identity_key` = COALESCE(`owner_member_id`, CASE WHEN `kind` = 'joint' THEN 'shared' ELSE 'unassigned' END) || '|' || CASE WHEN `kind` = 'credit_card' THEN 'card' ELSE 'cash' END || '|' || `normalized_name`;--> statement-breakpoint
UPDATE `financial_accounts` SET `shared_fallback` = `is_default` WHERE `ownership` = 'shared';--> statement-breakpoint
-- A marca global de padrao vira preferencia individual somente quando a conta tem dono.
UPDATE `household_members` SET `preferences` = json_set(`preferences`, '$.defaultAccountId', (SELECT a.`id` FROM `financial_accounts` a WHERE a.`owner_member_id` = `household_members`.`id` AND a.`is_default` = 1 AND a.`archived_at` IS NULL AND a.`kind` NOT IN ('credit_card', 'reserve') LIMIT 1)) WHERE json_extract(`preferences`, '$.defaultAccountId') IS NULL AND EXISTS (SELECT 1 FROM `financial_accounts` a WHERE a.`owner_member_id` = `household_members`.`id` AND a.`is_default` = 1 AND a.`archived_at` IS NULL AND a.`kind` NOT IN ('credit_card', 'reserve'));--> statement-breakpoint
CREATE UNIQUE INDEX `account_identity_uq` ON `financial_accounts` (`household_id`,`identity_key`) WHERE "financial_accounts"."archived_at" IS NULL AND "financial_accounts"."identity_key" <> '';--> statement-breakpoint
DROP INDEX `goal_household_name_uq`;--> statement-breakpoint
ALTER TABLE `financial_goals` ADD `normalized_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_goals` ADD `owner_member_id` text REFERENCES household_members(id);--> statement-breakpoint
ALTER TABLE `financial_goals` ADD `target_cents` integer;--> statement-breakpoint
UPDATE `financial_goals` SET `normalized_name` = lower(trim(`name`));--> statement-breakpoint
CREATE UNIQUE INDEX `goal_active_name_uq` ON `financial_goals` (`household_id`,`normalized_name`) WHERE "financial_goals"."status" = 'active' AND "financial_goals"."normalized_name" <> '';--> statement-breakpoint
ALTER TABLE `goal_contributions` ADD `account_id` text REFERENCES financial_accounts(id);--> statement-breakpoint
ALTER TABLE `goal_contributions` ADD `transaction_id` text REFERENCES financial_transactions(id);--> statement-breakpoint
CREATE INDEX `goal_contribution_account_idx` ON `goal_contributions` (`account_id`,`status`);--> statement-breakpoint
ALTER TABLE `recurring_entries` ADD `account_id` text REFERENCES financial_accounts(id);--> statement-breakpoint
ALTER TABLE `recurring_entries` ADD `frequency` text DEFAULT 'monthly' NOT NULL;