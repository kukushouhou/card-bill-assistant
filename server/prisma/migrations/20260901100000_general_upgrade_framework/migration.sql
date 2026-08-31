CREATE TABLE `UpgradePlan` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fromVersion` VARCHAR(32) NULL,
    `toVersion` VARCHAR(32) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'inspecting',
    `hasRequired` BOOLEAN NOT NULL DEFAULT false,
    `manifest` JSON NOT NULL,
    `error` VARCHAR(512) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `UpgradePlan_status_createdAt_idx` (`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UpgradeTask`
    ADD COLUMN `planId` INTEGER NULL,
    ADD COLUMN `mode` VARCHAR(16) NOT NULL DEFAULT 'optional',
    ADD COLUMN `migrationOrder` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `title` VARCHAR(100) NOT NULL DEFAULT '更新历史账单',
    ADD COLUMN `description` TEXT NULL,
    ADD COLUMN `executeLabel` VARCHAR(32) NOT NULL DEFAULT '现在执行',
    ADD COLUMN `ignoreLabel` VARCHAR(32) NULL DEFAULT '忽略迁移',
    ADD COLUMN `payload` JSON NULL,
    ADD COLUMN `succeeded` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `unchanged` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `approvedAt` DATETIME(3) NULL,
    ADD COLUMN `ignoredAt` DATETIME(3) NULL;

UPDATE `UpgradeTask`
SET `description` = '系统可以重新识别历史账单中的主卡、副卡、附属卡和手机信用卡。',
    `payload` = JSON_OBJECT('banks', JSON_EXTRACT(`banks`, '$')),
    `succeeded` = `updated`,
    `unchanged` = `missing`,
    `status` = CASE
        WHEN `status` = 'pending' THEN 'awaiting_decision'
        WHEN `status` = 'skipped' THEN 'ignored'
        ELSE `status`
    END,
    `ignoredAt` = CASE WHEN `status` = 'skipped' THEN COALESCE(`finishedAt`, `updatedAt`) ELSE NULL END;

ALTER TABLE `UpgradeTask`
    MODIFY `payload` JSON NOT NULL,
    MODIFY `description` TEXT NOT NULL,
    DROP COLUMN `banks`,
    DROP COLUMN `updated`,
    DROP COLUMN `missing`,
    ADD INDEX `UpgradeTask_planId_migrationOrder_idx` (`planId`, `migrationOrder`),
    ADD INDEX `UpgradeTask_status_createdAt_idx` (`status`, `createdAt`),
    ADD CONSTRAINT `UpgradeTask_planId_fkey`
        FOREIGN KEY (`planId`) REFERENCES `UpgradePlan`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `UpgradeTaskItem`
    ADD COLUMN `itemKey` VARCHAR(191) NULL,
    ADD COLUMN `payload` JSON NULL;

UPDATE `UpgradeTaskItem`
SET `itemKey` = CONCAT('mail:', `accountId`, ':', `uid`),
    `payload` = JSON_OBJECT(
        'accountId', `accountId`,
        'uid', `uid`,
        'bankName', `bankName`,
        'parserId', `parserId`
    );

ALTER TABLE `UpgradeTaskItem`
    DROP INDEX `UpgradeTaskItem_taskId_accountId_uid_key`,
    MODIFY `itemKey` VARCHAR(191) NOT NULL,
    MODIFY `payload` JSON NOT NULL,
    DROP COLUMN `accountId`,
    DROP COLUMN `uid`,
    DROP COLUMN `bankName`,
    DROP COLUMN `parserId`,
    ADD UNIQUE INDEX `UpgradeTaskItem_taskId_itemKey_key` (`taskId`, `itemKey`);
