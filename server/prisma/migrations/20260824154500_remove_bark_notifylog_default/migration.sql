-- NotifyLog 必须由发送调度器明确写入渠道类型，避免新调用方无意回落到特定提供方。
ALTER TABLE `NotifyLog` MODIFY `channel` VARCHAR(191) NOT NULL;
