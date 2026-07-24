-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('CREATING', 'READY_FOR_PREVIEW', 'PUBLISHED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DraftImageStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ImageProcessingStage" AS ENUM ('QUEUED', 'INGESTING_ORIGINAL', 'ENHANCING', 'UPLOADING_RESULT', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "product_drafts" (
    "id" TEXT NOT NULL,
    "seller_id" INTEGER NOT NULL,
    "tg_id" BIGINT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'CREATING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "form_step" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "category" "PartVehicleCategory",
    "title" VARCHAR(255),
    "description" TEXT,
    "part_number_type" "PartNumberType" NOT NULL DEFAULT 'UNKNOWN',
    "part_number" VARCHAR(50),
    "price_uzs" DECIMAL(14,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_draft_images" (
    "id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "status" "DraftImageStatus" NOT NULL DEFAULT 'PROCESSING',
    "stage" "ImageProcessingStage" NOT NULL DEFAULT 'QUEUED',
    "tg_file_id" TEXT NOT NULL,
    "original_url" TEXT,
    "original_public_id" TEXT,
    "processed_url" TEXT,
    "processed_public_id" TEXT,
    "job_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "product_draft_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_drafts_seller_id_status_idx" ON "product_drafts"("seller_id", "status");

-- CreateIndex
CREATE INDEX "product_drafts_expires_at_idx" ON "product_drafts"("expires_at");

-- CreateIndex
CREATE INDEX "product_draft_images_draft_id_sort_order_idx" ON "product_draft_images"("draft_id", "sort_order");

-- AddForeignKey
ALTER TABLE "product_draft_images" ADD CONSTRAINT "product_draft_images_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "product_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
