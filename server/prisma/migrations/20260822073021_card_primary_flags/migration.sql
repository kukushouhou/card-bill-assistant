-- AlterTable
ALTER TABLE `card` ADD COLUMN `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `primaryManual` BOOLEAN NOT NULL DEFAULT false;
