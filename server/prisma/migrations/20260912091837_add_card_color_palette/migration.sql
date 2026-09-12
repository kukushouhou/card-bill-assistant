-- AlterTable
ALTER TABLE `card` ADD COLUMN `colorPalette` INTEGER NULL;

-- AlterTable
ALTER TABLE `upgradetask` MODIFY `status` VARCHAR(24) NOT NULL DEFAULT 'awaiting_decision',
    ALTER COLUMN `title` DROP DEFAULT,
    ALTER COLUMN `ignoreLabel` DROP DEFAULT;
