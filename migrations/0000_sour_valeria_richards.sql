CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text,
	`member_id` text,
	`model` text NOT NULL,
	`operation` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_member_idx` ON `ai_usage` (`member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`actor_member_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_events` (`household_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_id` text NOT NULL,
	`period` text NOT NULL,
	`threshold` integer NOT NULL,
	`spent_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_alert_uq` ON `budget_alerts` (`budget_id`,`period`,`threshold`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`category_id` text,
	`member_id` text,
	`scope_key` text NOT NULL,
	`limit_cents` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "budget_limit_positive" CHECK("budgets"."limit_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_active_scope_uq` ON `budgets` (`household_id`,`scope_key`) WHERE "budgets"."archived_at" IS NULL;--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`nature` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_household_slug_uq` ON `categories` (`household_id`,`slug`);--> statement-breakpoint
CREATE TABLE `financial_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`kind` text NOT NULL,
	`owner_member_id` text,
	`opening_balance_cents` integer,
	`is_default` integer DEFAULT false NOT NULL,
	`credit_closing_day` integer,
	`credit_due_day` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_household_name_uq` ON `financial_accounts` (`household_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `financial_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`entry_cents` integer,
	`additional_costs_cents` integer,
	`deadline` text,
	`planned_monthly_cents` integer,
	`emergency_reserve_cents` integer,
	`notes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_household_name_uq` ON `financial_goals` (`household_id`,`name`);--> statement-breakpoint
CREATE TABLE `financial_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`type` text NOT NULL,
	`transfer_kind` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`description` text NOT NULL,
	`category_id` text,
	`source_account_id` text,
	`destination_account_id` text,
	`member_id` text NOT NULL,
	`is_shared` integer DEFAULT false NOT NULL,
	`created_by_member_id` text NOT NULL,
	`financial_date` text NOT NULL,
	`origin` text NOT NULL,
	`source_chat_id` text,
	`source_message_id` integer,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`voided_at` integer,
	`voided_by_member_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_account_id`) REFERENCES `financial_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_account_id`) REFERENCES `financial_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tx_amount_positive" CHECK("financial_transactions"."amount_cents" > 0),
	CONSTRAINT "tx_shape" CHECK(("financial_transactions"."type" = 'transfer' AND "financial_transactions"."source_account_id" IS NOT NULL AND "financial_transactions"."destination_account_id" IS NOT NULL AND "financial_transactions"."source_account_id" <> "financial_transactions"."destination_account_id" AND "financial_transactions"."transfer_kind" IS NOT NULL AND "financial_transactions"."category_id" IS NULL)
       OR ("financial_transactions"."type" = 'expense' AND "financial_transactions"."destination_account_id" IS NULL AND "financial_transactions"."transfer_kind" IS NULL)
       OR ("financial_transactions"."type" = 'income' AND "financial_transactions"."source_account_id" IS NULL AND "financial_transactions"."transfer_kind" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `financial_transactions_idempotency_key_unique` ON `financial_transactions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `tx_household_date_idx` ON `financial_transactions` (`household_id`,`status`,`financial_date`);--> statement-breakpoint
CREATE INDEX `tx_household_message_idx` ON `financial_transactions` (`household_id`,`source_chat_id`,`source_message_id`);--> statement-breakpoint
CREATE TABLE `goal_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`contribution_date` text NOT NULL,
	`member_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `financial_goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "goal_contribution_positive" CHECK("goal_contributions"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_contributions_idempotency_key_unique` ON `goal_contributions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `goal_contribution_goal_idx` ON `goal_contributions` (`goal_id`,`status`);--> statement-breakpoint
CREATE TABLE `household_members` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`telegram_user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`preferences` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_household_telegram_uq` ON `household_members` (`household_id`,`telegram_user_id`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`timezone` text DEFAULT 'America/Maceio' NOT NULL,
	`telegram_chat_id` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `households_telegram_chat_id_unique` ON `households` (`telegram_chat_id`);--> statement-breakpoint
CREATE TABLE `incoming_events` (
	`id` text PRIMARY KEY NOT NULL,
	`update_id` integer NOT NULL,
	`household_id` text,
	`kind` text NOT NULL,
	`chat_id` text NOT NULL,
	`sender_telegram_id` text NOT NULL,
	`message_id` integer,
	`message_date` integer NOT NULL,
	`payload` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`last_error_code` text,
	`notice_sent` integer DEFAULT false NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incoming_events_update_id_unique` ON `incoming_events` (`update_id`);--> statement-breakpoint
CREATE INDEX `event_queue_idx` ON `incoming_events` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_message_uq` ON `incoming_events` (`chat_id`,`message_id`) WHERE "incoming_events"."kind" = 'message' AND "incoming_events"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`total_cents` integer NOT NULL,
	`installment_count` integer NOT NULL,
	`first_due_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `financial_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installment_plans_transaction_id_unique` ON `installment_plans` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `installments` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`due_date` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`plan_id`) REFERENCES `installment_plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installment_plan_seq_uq` ON `installments` (`plan_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `outgoing_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text,
	`chat_id` text NOT NULL,
	`text` text,
	`reply_to_message_id` integer,
	`reply_markup` text,
	`dedup_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outgoing_messages_dedup_key_unique` ON `outgoing_messages` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `outbox_queue_idx` ON `outgoing_messages` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_lookup_idx` ON `pending_actions` (`household_id`,`status`,`member_id`);--> statement-breakpoint
CREATE TABLE `recurring_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`normalized_description` text NOT NULL,
	`category_id` text,
	`member_id` text,
	`member_key` text NOT NULL,
	`amount_cents` integer,
	`schedule_type` text NOT NULL,
	`schedule_value` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_active_name_uq` ON `recurring_entries` (`household_id`,`kind`,`normalized_description`,`member_key`) WHERE "recurring_entries"."active" = 1;--> statement-breakpoint
CREATE TABLE `recurring_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`period` text NOT NULL,
	`transaction_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `recurring_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `financial_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_settlement_uq` ON `recurring_settlements` (`entry_id`,`period`);