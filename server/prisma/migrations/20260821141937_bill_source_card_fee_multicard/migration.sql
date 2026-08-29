-- AlterTable
ALTER TABLE `bill` ADD COLUMN `source` VARCHAR(191) NOT NULL DEFAULT 'email',
    MODIFY `amount` DECIMAL(12, 2) NULL;

-- AlterTable
ALTER TABLE `card` ADD COLUMN `annualFeeDate` DATETIME(3) NULL,
    ADD COLUMN `annualFeeDateManual` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `BillCard` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `billId` INTEGER NOT NULL,
    `cardId` INTEGER NOT NULL,

    INDEX `BillCard_cardId_idx`(`cardId`),
    UNIQUE INDEX `BillCard_billId_cardId_key`(`billId`, `cardId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BillCard` ADD CONSTRAINT `BillCard_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillCard` ADD CONSTRAINT `BillCard_cardId_fkey` FOREIGN KEY (`cardId`) REFERENCES `Card`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
