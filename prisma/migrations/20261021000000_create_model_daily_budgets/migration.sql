CREATE TABLE `processing_model_daily_budgets` (
    `day` CHAR(10) NOT NULL,
    `record` JSON NOT NULL,
    PRIMARY KEY (`day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
