-- AlterTable
ALTER TABLE `card` ADD COLUMN `priority` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `displayLast4` VARCHAR(191) NOT NULL DEFAULT '----',
    ADD COLUMN `hidden` BOOLEAN NOT NULL DEFAULT false;

-- 已有库：展示尾号与匹配尾号对齐（占位仍为 ----，非占位强制一致）
UPDATE `card` SET `displayLast4` = `cardLast4`;
