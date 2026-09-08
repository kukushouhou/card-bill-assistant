-- 账户共享明细关联原账单邮件，不产生单卡应还义务，也不属于未出账交易。
ALTER TABLE `BillTransaction` ADD COLUMN `statementMailLogId` INTEGER NULL;
CREATE UNIQUE INDEX `BillTransaction_statementMailLogId_sequence_key` ON `BillTransaction` (`statementMailLogId`, `sequence`);
ALTER TABLE `BillTransaction` ADD CONSTRAINT `BillTransaction_statementMailLogId_fkey`
  FOREIGN KEY (`statementMailLogId`) REFERENCES `MailLog` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
