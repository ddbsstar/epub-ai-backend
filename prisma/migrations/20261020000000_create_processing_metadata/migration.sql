CREATE TABLE `processing_books` (
  `id` CHAR(36) NOT NULL,
  `ownerId` VARCHAR(100) NOT NULL,
  `record` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL,
  INDEX `processing_books_ownerId_createdAt_idx` (`ownerId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE `processing_runs` (
  `id` CHAR(36) NOT NULL,
  `ownerId` VARCHAR(100) NOT NULL,
  `bookId` CHAR(36) NOT NULL,
  `operation` VARCHAR(64) NOT NULL,
  `idempotencyKey` VARCHAR(100) NOT NULL,
  `status` VARCHAR(24) NOT NULL,
  `record` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `processing_runs_ownerId_operation_idempotencyKey_key` (`ownerId`, `operation`, `idempotencyKey`),
  INDEX `processing_runs_ownerId_status_idx` (`ownerId`, `status`),
  INDEX `processing_runs_status_updatedAt_idx` (`status`, `updatedAt`),
  INDEX `processing_runs_bookId_idx` (`bookId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE `processing_artifacts` (
  `id` CHAR(36) NOT NULL,
  `ownerId` VARCHAR(100) NOT NULL,
  `runId` CHAR(36) NOT NULL,
  `bookId` CHAR(36) NOT NULL,
  `record` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL,
  INDEX `processing_artifacts_runId_idx` (`runId`),
  INDEX `processing_artifacts_ownerId_createdAt_idx` (`ownerId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE `processing_admission_locks` (
  `id` VARCHAR(24) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
INSERT INTO `processing_admission_locks` (`id`) VALUES ('global');
