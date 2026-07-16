-- DropForeignKey
ALTER TABLE "user_cars" DROP CONSTRAINT "user_cars_user_id_fkey";

-- AddForeignKey
ALTER TABLE "user_cars" ADD CONSTRAINT "user_cars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
