ALTER TABLE `execution_reports` ADD COLUMN `stopLossOrderId` text;
--> statement-breakpoint
ALTER TABLE `execution_reports` ADD COLUMN `takeProfitOrderId` text;
--> statement-breakpoint
ALTER TABLE `execution_reports` ADD COLUMN `compensationState` text;
--> statement-breakpoint
ALTER TABLE `execution_reports` ADD COLUMN `compensationOrderId` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_trades_account_signal_idx`
	ON `demo_trades` (`demoAccountId`, `signalId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_snapshots_account_trade_count_idx`
	ON `portfolio_snapshots` (`demoAccountId`, `tradeCount`);
