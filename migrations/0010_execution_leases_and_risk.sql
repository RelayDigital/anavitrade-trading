-- Forward-only alignment for fields already declared by Drizzle and lease-v1.
ALTER TABLE `live_accounts` ADD COLUMN `lastTotalEquityUsd` text;
--> statement-breakpoint
ALTER TABLE `live_accounts` ADD COLUMN `lastAvailableUsd` text;
--> statement-breakpoint
ALTER TABLE `live_accounts` ADD COLUMN `depositAddress` text;
--> statement-breakpoint
ALTER TABLE `live_accounts` ADD COLUMN `linkedExchangesJson` text;
--> statement-breakpoint
ALTER TABLE `cex_connections` ADD COLUMN `consecutiveLosses` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `cex_connections` ADD COLUMN `circuitBreakerUntil` text;
--> statement-breakpoint
ALTER TABLE `cex_connections` ADD COLUMN `highWaterMark` text;
--> statement-breakpoint
ALTER TABLE `trade_intents` ADD COLUMN `sourceSignal` text;
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `riskApproved` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `leaseToken` text;
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `leaseOwner` text;
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `leaseExpiresAt` integer;
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `leaseAttempt` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `leaseAction` text;
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `leasePreviousStatus` text;
--> statement-breakpoint
ALTER TABLE `order_events` ADD COLUMN `exchangeOrderId` text;
--> statement-breakpoint
CREATE TABLE `execution_reports` (
	`reportId` text PRIMARY KEY NOT NULL,
	`executionJobId` integer NOT NULL,
	`leaseAttempt` integer NOT NULL,
	`status` text NOT NULL,
	`orderId` text,
	`errorCode` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `execution_reports_job_idx` ON `execution_reports` (`executionJobId`, `leaseAttempt`);
--> statement-breakpoint
CREATE INDEX `execution_jobs_claim_eligibility_idx`
	ON `execution_jobs` (`provider`, `riskApproved`, `status`, `leaseAttempt`, `queuedAt`);
--> statement-breakpoint
CREATE INDEX `execution_jobs_lease_expiry_idx`
	ON `execution_jobs` (`status`, `leaseAction`, `leaseExpiresAt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_signals_external_signal_id_idx`
	ON `analysis_signals` (`externalSignalId`);
