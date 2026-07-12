ALTER TABLE demo_accounts ADD COLUMN `userId` integer UNIQUE;
--> statement-breakpoint
ALTER TABLE live_accounts ADD COLUMN `displayMode` text DEFAULT 'live' NOT NULL;
