ALTER TABLE `Card`
    ADD COLUMN `businessRole` VARCHAR(191) NOT NULL DEFAULT 'standalone',
    ADD COLUMN `businessPrimaryId` INTEGER NULL,
    ADD COLUMN `businessRelationDate` DATETIME(3) NULL,
    ADD INDEX `Card_businessPrimaryId_idx` (`businessPrimaryId`);

ALTER TABLE `BillTransaction`
    ADD COLUMN `sourceCardLast4` VARCHAR(8) NULL;

CREATE TABLE `CardAlias` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `bankName` VARCHAR(191) NOT NULL,
    `cardLast4` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'mobile',
    `primaryCardId` INTEGER NOT NULL,
    `relationDate` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `CardAlias_bankName_cardLast4_key` (`bankName`, `cardLast4`),
    INDEX `CardAlias_primaryCardId_idx` (`primaryCardId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `UpgradeTask` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(100) NOT NULL,
    `fromVersion` VARCHAR(32) NULL,
    `toVersion` VARCHAR(32) NOT NULL,
    `banks` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `total` INTEGER NOT NULL DEFAULT 0,
    `processed` INTEGER NOT NULL DEFAULT 0,
    `updated` INTEGER NOT NULL DEFAULT 0,
    `missing` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `error` VARCHAR(512) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `UpgradeTask_key_key` (`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `UpgradeTaskItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `taskId` INTEGER NOT NULL,
    `accountId` INTEGER NOT NULL,
    `uid` INTEGER NOT NULL,
    `bankName` VARCHAR(64) NOT NULL,
    `parserId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `error` VARCHAR(512) NULL,
    `processedAt` DATETIME(3) NULL,
    UNIQUE INDEX `UpgradeTaskItem_taskId_accountId_uid_key` (`taskId`, `accountId`, `uid`),
    INDEX `UpgradeTaskItem_taskId_status_idx` (`taskId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Card`
    ADD CONSTRAINT `Card_businessPrimaryId_fkey`
    FOREIGN KEY (`businessPrimaryId`) REFERENCES `Card`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CardAlias`
    ADD CONSTRAINT `CardAlias_primaryCardId_fkey`
    FOREIGN KEY (`primaryCardId`) REFERENCES `Card`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `UpgradeTaskItem`
    ADD CONSTRAINT `UpgradeTaskItem_taskId_fkey`
    FOREIGN KEY (`taskId`) REFERENCES `UpgradeTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
