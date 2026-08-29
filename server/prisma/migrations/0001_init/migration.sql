-- CreateTable
CREATE TABLE `Admin` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `pinSalt` LONGBLOB NULL,
    `pinVerifier` LONGBLOB NULL,
    `pinFailCount` INTEGER NOT NULL DEFAULT 0,
    `pinLockedUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Admin_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppSetting` (
    `key` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailAccount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(191) NOT NULL,
    `imapHost` VARCHAR(191) NOT NULL,
    `imapPort` INTEGER NOT NULL DEFAULT 993,
    `tls` BOOLEAN NOT NULL DEFAULT true,
    `authUser` VARCHAR(191) NOT NULL,
    `authPasswordEnc` LONGBLOB NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `lastUid` INTEGER NOT NULL DEFAULT 0,
    `lastSyncAt` DATETIME(3) NULL,
    `syncDaysBack` INTEGER NOT NULL DEFAULT 90,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Card` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `bankName` VARCHAR(191) NOT NULL,
    `cardLast4` VARCHAR(191) NOT NULL,
    `cardNoFullEnc` LONGBLOB NULL,
    `expDateEnc` LONGBLOB NULL,
    `cvvEnc` LONGBLOB NULL,
    `holderName` VARCHAR(191) NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'CNY',
    `statementDay` INTEGER NOT NULL,
    `dueRule` VARCHAR(191) NOT NULL DEFAULT 'offset',
    `dueDay` INTEGER NULL,
    `dueOffsetDays` INTEGER NULL,
    `remindDaysBefore` JSON NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Card_bankName_cardLast4_key`(`bankName`, `cardLast4`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Bill` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cardId` INTEGER NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `statementDate` DATETIME(3) NOT NULL,
    `dueDate` DATETIME(3) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `minAmount` DECIMAL(12, 2) NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'CNY',
    `paidStatus` VARCHAR(191) NOT NULL DEFAULT 'unpaid',
    `paidAt` DATETIME(3) NULL,
    `mailLogId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Bill_cardId_period_key`(`cardId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomReminder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `dayOfMonth` INTEGER NULL,
    `specificDate` DATETIME(3) NULL,
    `daysBefore` JSON NOT NULL,
    `note` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MailLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NOT NULL,
    `uid` INTEGER NOT NULL,
    `messageId` VARCHAR(255) NULL,
    `fromAddress` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(512) NOT NULL,
    `mailDate` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'unmatched',
    `parserId` VARCHAR(191) NULL,
    `billId` INTEGER NULL,
    `error` VARCHAR(512) NULL,
    `processedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `MailLog_accountId_uid_key`(`accountId`, `uid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotifyLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(191) NOT NULL,
    `refId` INTEGER NOT NULL,
    `fireDate` DATETIME(3) NOT NULL,
    `channel` VARCHAR(191) NOT NULL DEFAULT 'bark',
    `status` VARCHAR(191) NOT NULL DEFAULT 'sent',
    `detail` VARCHAR(512) NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `NotifyLog_type_refId_fireDate_channel_key`(`type`, `refId`, `fireDate`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_cardId_fkey` FOREIGN KEY (`cardId`) REFERENCES `Card`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MailLog` ADD CONSTRAINT `MailLog_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `EmailAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
