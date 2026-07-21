-- Unified analysis engine: klines, derivatives_snapshots, analysis_signals, analysis_runs
--> statement-breakpoint
CREATE TABLE `klines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`openTime` integer NOT NULL,
	`open` text NOT NULL,
	`high` text NOT NULL,
	`low` text NOT NULL,
	`close` text NOT NULL,
	`volume` text NOT NULL,
	`closeTime` integer NOT NULL,
	`fetchedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `klines_symbol_tf_opentime_idx` ON `klines` (`symbol`, `timeframe`, `openTime`);
--> statement-breakpoint
CREATE INDEX `klines_symbol_tf_idx` ON `klines` (`symbol`, `timeframe`);
--> statement-breakpoint
CREATE TABLE `derivatives_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`openInterest` text NOT NULL,
	`oiChange24hPct` text,
	`fundingRate` text,
	`longShortRatio` text,
	`longPct` text,
	`shortPct` text,
	`snapshotAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `derivatives_snapshots_symbol_snapshotat_idx` ON `derivatives_snapshots` (`symbol`, `snapshotAt`);
--> statement-breakpoint
CREATE TABLE `analysis_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`externalSignalId` text,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`direction` text NOT NULL,
	`entry` text NOT NULL,
	`stopLoss` text,
	`takeProfit` text,
	`score` integer DEFAULT 0 NOT NULL,
	`tier` text DEFAULT 'C' NOT NULL,
	`thesis` text,
	`componentsJson` text,
	`structuralScore` integer,
	`structuralConfidence` text,
	`metadataJson` text,
	`dispatched` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`dispatchedAt` integer
);
--> statement-breakpoint
CREATE INDEX `analysis_signals_source_idx` ON `analysis_signals` (`source`);
--> statement-breakpoint
CREATE INDEX `analysis_signals_tier_createdat_idx` ON `analysis_signals` (`tier`, `createdAt`);
--> statement-breakpoint
CREATE INDEX `analysis_signals_symbol_createdat_idx` ON `analysis_signals` (`symbol`, `createdAt`);
--> statement-breakpoint
CREATE TABLE `analysis_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`signalsGenerated` integer DEFAULT 0 NOT NULL,
	`signalsDispatched` integer DEFAULT 0 NOT NULL,
	`signalsRejected` integer DEFAULT 0 NOT NULL,
	`klineUpdates` integer DEFAULT 0 NOT NULL,
	`errorMessage` text,
	`durationMs` integer,
	`startedAt` integer NOT NULL,
	`completedAt` integer
);
