CREATE TABLE `pancakeswap_delegations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`walletAddress` text NOT NULL,
	`tokenAddress` text NOT NULL,
	`spenderAddress` text NOT NULL,
	`amountCap` text NOT NULL,
	`expiration` integer NOT NULL,
	`nonce` integer NOT NULL,
	`sigDeadline` integer NOT NULL,
	`signature` text,
	`permitTxHash` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`lastValidatedAt` integer,
	`revokedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pancakeswap_delegations_user_token_idx` ON `pancakeswap_delegations` (`userId`,`tokenAddress`);
--> statement-breakpoint
CREATE TABLE `pancakeswap_agent_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`signerAddress` text NOT NULL,
	`encryptedSignerPrivateKey` text NOT NULL,
	`status` text DEFAULT 'pending_approval' NOT NULL,
	`lastValidatedAt` integer,
	`revokedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `execution_jobs` ADD COLUMN `pancakeswapDelegationId` integer;
