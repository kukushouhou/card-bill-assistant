-- AlterTable
ALTER TABLE `bill` ADD COLUMN `annualFeeAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `hasDetails` BOOLEAN NOT NULL DEFAULT false;
