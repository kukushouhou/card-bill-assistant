-- 仅变更结构。旧渠道和发送日志原样保留，NULL 标识继续使用旧渠道类型去重。
ALTER TABLE `NotificationChannel`
    ADD COLUMN `deliveryKey` VARCHAR(191) NULL,
    DROP INDEX `NotificationChannel_type_key`,
    ADD UNIQUE INDEX `NotificationChannel_deliveryKey_key` (`deliveryKey`);
