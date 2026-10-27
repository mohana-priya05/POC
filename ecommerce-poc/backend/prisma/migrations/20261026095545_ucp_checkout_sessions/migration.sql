-- CreateTable
CREATE TABLE `CheckoutSession` (
    `id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'INR',
    `lineItems` JSON NOT NULL,
    `buyer` JSON NULL,
    `platformProfile` VARCHAR(512) NULL,
    `orderId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CheckoutSession_orderId_key`(`orderId`),
    INDEX `CheckoutSession_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IdempotencyRecord` (
    `id` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(255) NOT NULL,
    `idemKey` VARCHAR(128) NOT NULL,
    `requestHash` VARCHAR(64) NOT NULL,
    `state` VARCHAR(16) NOT NULL,
    `responseStatus` INTEGER NULL,
    `responseBody` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IdempotencyRecord_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `IdempotencyRecord_scope_idemKey_key`(`scope`, `idemKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CheckoutSession` ADD CONSTRAINT `CheckoutSession_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
