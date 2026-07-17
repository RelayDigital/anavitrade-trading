-- D1/SQLite cannot add a UNIQUE column with ALTER TABLE. Add the nullable
-- column first, then enforce uniqueness with a separate index.
ALTER TABLE demo_accounts ADD COLUMN `userId` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_accounts_user_id_unique` ON `demo_accounts` (`userId`);
--> statement-breakpoint
ALTER TABLE live_accounts ADD COLUMN `displayMode` text DEFAULT 'demo' NOT NULL;
