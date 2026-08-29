-- 本任务不保留旧自定义提醒数据；数据库会在任务完成后由用户清空并重新初始化。
ALTER TABLE `CustomReminder`
    ADD COLUMN `businessType` VARCHAR(191) NOT NULL DEFAULT 'general',
    ADD COLUMN `interval` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `anchorDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `dayOfWeek` INTEGER NULL,
    ADD COLUMN `monthOfYear` INTEGER NULL,
    ADD COLUMN `fixedAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `disabledAt` DATETIME(3) NULL,
    ADD COLUMN `hideOpenWhenDisabled` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `CustomReminderOccurrence` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reminderId` INTEGER NULL,
    `name` VARCHAR(191) NOT NULL,
    `businessType` VARCHAR(191) NOT NULL,
    `targetDate` DATETIME(3) NOT NULL,
    `availableDate` DATETIME(3) NOT NULL,
    `daysBefore` JSON NOT NULL,
    `note` VARCHAR(191) NULL,
    `amount` DECIMAL(12, 2) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `completedAt` DATETIME(3) NULL,
    `suspended` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CustomReminderOccurrence_reminderId_targetDate_key`(`reminderId`, `targetDate`),
    INDEX `CustomReminderOccurrence_targetDate_status_suspended_idx`(`targetDate`, `status`, `suspended`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CustomReminderOccurrence`
    ADD CONSTRAINT `CustomReminderOccurrence_reminderId_fkey`
    FOREIGN KEY (`reminderId`) REFERENCES `CustomReminder`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
