-- CreateTable
CREATE TABLE "sellers" (
    "id" SERIAL NOT NULL,
    "tg_id" BIGINT NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "store_name" VARCHAR(100),
    "market_name" VARCHAR(100),
    "address_comment" TEXT,
    "location_lat" DOUBLE PRECISION,
    "location_lng" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "gm_number" VARCHAR(50),
    "title" VARCHAR(255) NOT NULL,
    "car_model" VARCHAR(100),
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocks" (
    "id" SERIAL NOT NULL,
    "seller_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "price_uzs" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "yandex_claim_id" VARCHAR(100),
    "delivery_cost" DECIMAL(10,2),
    "total_cost" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sellers_tg_id_key" ON "sellers"("tg_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_gm_number_key" ON "products"("gm_number");

-- CreateIndex
CREATE UNIQUE INDEX "stocks_seller_id_product_id_key" ON "stocks"("seller_id", "product_id");

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
