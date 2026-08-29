-- 招商日度交易可在正式出账前独立存在，并由源邮件保证幂等。
ALTER TABLE `Bill`
  ADD COLUMN `cycleStartDate` DATETIME(3) NULL AFTER `period`;

ALTER TABLE `BillTransaction`
  DROP FOREIGN KEY `BillTransaction_billId_fkey`;

ALTER TABLE `BillTransaction`
  MODIFY `billId` INTEGER NULL,
  ADD COLUMN `bankName` VARCHAR(64) NULL AFTER `billId`,
  ADD COLUMN `dailyMailLogId` INTEGER NULL AFTER `bankName`;

-- 已有正式账单明细回填银行快照，随后收紧为必填。
UPDATE `BillTransaction` bt
INNER JOIN `Bill` b ON b.`id` = bt.`billId`
INNER JOIN `Card` c ON c.`id` = b.`cardId`
SET bt.`bankName` = c.`bankName`;

ALTER TABLE `BillTransaction`
  MODIFY `bankName` VARCHAR(64) NOT NULL;

CREATE UNIQUE INDEX `BillTransaction_dailyMailLogId_sequence_key`
  ON `BillTransaction`(`dailyMailLogId`, `sequence`);
CREATE INDEX `BillTransaction_bankName_transactionDate_idx`
  ON `BillTransaction`(`bankName`, `transactionDate`);

ALTER TABLE `BillTransaction`
  ADD CONSTRAINT `BillTransaction_billId_fkey`
  FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `BillTransaction`
  ADD CONSTRAINT `BillTransaction_dailyMailLogId_fkey`
  FOREIGN KEY (`dailyMailLogId`) REFERENCES `MailLog`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
