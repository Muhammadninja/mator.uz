-- Customers asking Mator AI for a photo of a part that has none.
ALTER TYPE "NotificationType" ADD VALUE 'PRODUCT_PHOTO_ADDED';

CREATE TYPE "PhotoRequestStatus" AS ENUM ('PENDING', 'FULFILLED');

CREATE TABLE "photo_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "part_id" VARCHAR(64) NOT NULL,
    "part_title" TEXT NOT NULL,
    "status" "PhotoRequestStatus" NOT NULL DEFAULT 'PENDING',
    "staff_notified_at" TIMESTAMP(3),
    "staff_notify_attempts" INTEGER NOT NULL DEFAULT 0,
    "fulfilled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photo_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "photo_requests_user_id_part_id_key" ON "photo_requests"("user_id", "part_id");
CREATE INDEX "photo_requests_status_part_id_idx" ON "photo_requests"("status", "part_id");

ALTER TABLE "photo_requests" ADD CONSTRAINT "photo_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
