-- CreateTable
CREATE TABLE `background_jobs` (
    `id` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'queued',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `background_jobs_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
