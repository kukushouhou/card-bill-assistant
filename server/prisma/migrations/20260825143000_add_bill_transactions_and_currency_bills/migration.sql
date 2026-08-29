-- 一封邮件可生成多张独立币种账单；账单与源邮件保留可置空关联。
ALTER TABLE `MailLog` DROP COLUMN `billId`;

-- 先创建新索引，再删除旧索引：Bill_cardId_fkey 需要 cardId 前缀索引持续存在。
CREATE UNIQUE INDEX `Bill_cardId_period_currency_key` ON `Bill`(`cardId`, `period`, `currency`);
DROP INDEX `Bill_cardId_period_key` ON `Bill`;
CREATE INDEX `Bill_mailLogId_idx` ON `Bill`(`mailLogId`);
UPDATE `Bill` b
LEFT JOIN `MailLog` m ON m.`id` = b.`mailLogId`
SET b.`mailLogId` = NULL
WHERE b.`mailLogId` IS NOT NULL AND m.`id` IS NULL;
ALTER TABLE `Bill`
  ADD CONSTRAINT `Bill_mailLogId_fkey`
  FOREIGN KEY (`mailLogId`) REFERENCES `MailLog`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `BillTransaction` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `billId` INTEGER NOT NULL,
  `cardId` INTEGER NULL,
  `cardLast4` VARCHAR(8) NULL,
  `transactionDate` DATETIME(3) NULL,
  `dateText` VARCHAR(32) NULL,
  `description` VARCHAR(512) NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `currency` VARCHAR(8) NOT NULL,
  `originalAmount` DECIMAL(12, 2) NULL,
  `originalCurrency` VARCHAR(8) NULL,
  `sequence` INTEGER NOT NULL,

  UNIQUE INDEX `BillTransaction_billId_sequence_key`(`billId`, `sequence`),
  INDEX `BillTransaction_transactionDate_id_idx`(`transactionDate`, `id`),
  INDEX `BillTransaction_cardId_transactionDate_idx`(`cardId`, `transactionDate`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BillTransaction`
  ADD CONSTRAINT `BillTransaction_billId_fkey`
  FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `BillTransaction`
  ADD CONSTRAINT `BillTransaction_cardId_fkey`
  FOREIGN KEY (`cardId`) REFERENCES `Card`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
