-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'SELLER', 'ADMIN');

-- AlterTable
ALTER TABLE "app_users" ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'USER';
