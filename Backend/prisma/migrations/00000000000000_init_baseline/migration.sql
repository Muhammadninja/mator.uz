-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SellerStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'SELLER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('GOOGLE', 'APPLE', 'PHONE_OTP', 'MYID');

-- CreateEnum
CREATE TYPE "MyIdStatus" AS ENUM ('NOT_VERIFIED', 'PENDING', 'VERIFIED');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('RU', 'UZ', 'EN');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('MASTER', 'STO');

-- CreateEnum
CREATE TYPE "Specialization" AS ENUM ('ENGINE', 'TRANSMISSION', 'ELECTRICAL', 'BODY', 'PAINT', 'SUSPENSION', 'DIAGNOSTICS', 'TIRES', 'AC');

-- CreateEnum
CREATE TYPE "VehicleTransmission" AS ENUM ('MANUAL', 'AUTOMATIC', 'CVT', 'AMT', 'ROBOT');

-- CreateEnum
CREATE TYPE "Drivetrain" AS ENUM ('FWD', 'RWD', 'AWD');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'GAS');

-- CreateEnum
CREATE TYPE "VehicleServiceStage" AS ENUM ('QUEUED', 'IN_PROGRESS', 'AWAITING_PARTS', 'READY', 'FLAGGED');

-- CreateEnum
CREATE TYPE "CompatibilityStatus" AS ENUM ('FITS', 'MAYBE', 'DOES_NOT_FIT');

-- CreateEnum
CREATE TYPE "PartCondition" AS ENUM ('NEW', 'USED', 'REFURBISHED');

-- CreateEnum
CREATE TYPE "PartMainCategory" AS ENUM ('BRAKES', 'BATTERIES', 'FILTERS', 'IGNITION', 'ENGINE', 'ELECTRICAL_PARTS', 'OIL_AND_FLUIDS', 'BELTS_AND_HOSES', 'WIPERS', 'LIGHTING', 'SUSPENSION', 'EXTERIOR');

-- CreateEnum
CREATE TYPE "PartVehicleCategory" AS ENUM ('BRAKE_SYSTEM', 'MAINTENANCE_AND_FLUIDS', 'SUSPENSION_AND_STEERING', 'ELECTRICAL_AND_LIGHTING', 'ENGINE', 'TRANSMISSION', 'HEATING_AND_COOLING', 'TUNING_AND_ACCESSORIES');

-- CreateEnum
CREATE TYPE "PartOriginRegion" AS ENUM ('CHINA', 'EUROPE', 'RUSSIA', 'KOREA', 'USA', 'JAPAN');

-- CreateEnum
CREATE TYPE "PartNumberType" AS ENUM ('GM', 'OEM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('HOLD', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('COURIER', 'PICKUP');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('PAYME', 'CLICK');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ORDER_PAID', 'ORDER_STATUS_CHANGED', 'PAYMENT_PAID', 'AI_REPLY', 'MASTER_MESSAGE', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'VEHICLE_STATUS_UPDATED', 'MYID_VERIFIED', 'MARKETING');

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

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
    "status" "SellerStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "car_models" (
    "id" SERIAL NOT NULL,
    "brand_id" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "car_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "gm_number" VARCHAR(50),
    "oem_number" VARCHAR(50),
    "part_number_type" "PartNumberType" NOT NULL DEFAULT 'UNKNOWN',
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "is_universal" BOOLEAN NOT NULL DEFAULT false,
    "main_category" "PartMainCategory",
    "vehicle_category" "PartVehicleCategory",
    "part_brand" VARCHAR(120),
    "origin_region" "PartOriginRegion",
    "is_oem" BOOLEAN NOT NULL DEFAULT false,
    "is_gm" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_models" (
    "part_id" INTEGER NOT NULL,
    "model_id" INTEGER NOT NULL,

    CONSTRAINT "part_models_pkey" PRIMARY KEY ("part_id","model_id")
);

-- CreateTable
CREATE TABLE "oem_compatibility" (
    "id" SERIAL NOT NULL,
    "oem_number" VARCHAR(50) NOT NULL,
    "make" VARCHAR(120) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oem_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocks" (
    "id" SERIAL NOT NULL,
    "seller_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "price_uzs" DECIMAL(14,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255),
    "password_hash" VARCHAR(255),
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "phone_e164" VARCHAR(20),
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "display_name" VARCHAR(120),
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "avatar_url" TEXT,
    "thumbnail_url" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "language" "Language" NOT NULL DEFAULT 'UZ',
    "myid_status" "MyIdStatus" NOT NULL DEFAULT 'NOT_VERIFIED',
    "transaction_limit_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" SERIAL NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "provider_user_id" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" SERIAL NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_otp_requests" (
    "id" VARCHAR(64) NOT NULL,
    "phone_e164" VARCHAR(20) NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "channel" "OtpChannel" NOT NULL DEFAULT 'SMS',
    "purpose" VARCHAR(40) NOT NULL DEFAULT 'login',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_otp_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myid_sessions" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "state" VARCHAR(120) NOT NULL,
    "code_challenge" VARCHAR(255) NOT NULL,
    "code_challenge_method" VARCHAR(10) NOT NULL DEFAULT 'S256',
    "code_verifier" VARCHAR(255),
    "scopes" TEXT[],
    "redirect_uri" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "myid_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myid_verifications" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" VARCHAR(64),
    "status" VARCHAR(20) NOT NULL,
    "pinfl" VARCHAR(14),
    "passport_serial" VARCHAR(2),
    "passport_number" VARCHAR(20),
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "middle_name" VARCHAR(100),
    "date_of_birth" DATE,
    "gender" "Gender",
    "citizenship_iso3" VARCHAR(3),
    "address_region" VARCHAR(120),
    "address_district" VARCHAR(120),
    "address_street" TEXT,
    "biometric_match_score" DECIMAL(4,3),
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "myid_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "label" VARCHAR(80),
    "region_code" VARCHAR(10),
    "district" VARCHAR(120),
    "street" TEXT,
    "full_text" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_makes" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "logo_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vehicle_makes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_models" (
    "id" VARCHAR(64) NOT NULL,
    "make_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,

    CONSTRAINT "vehicle_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_trims" (
    "id" VARCHAR(64) NOT NULL,
    "model_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,

    CONSTRAINT "vehicle_trims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_engines" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "displacement_cc" INTEGER,
    "fuel_type" "FuelType",

    CONSTRAINT "vehicle_engines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_3d_assets" (
    "id" VARCHAR(64) NOT NULL,
    "trim_id" VARCHAR(64),
    "glb_url" TEXT NOT NULL,
    "ktx2_textures_url" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "byte_size" INTEGER,
    "checksum_sha256" VARCHAR(64),

    CONSTRAINT "vehicle_3d_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tuning_variants" (
    "id" VARCHAR(64) NOT NULL,
    "asset_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "thumbnail_url" TEXT,

    CONSTRAINT "tuning_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "nickname" VARCHAR(120),
    "make_id" VARCHAR(64) NOT NULL,
    "model_id" VARCHAR(64) NOT NULL,
    "year" INTEGER NOT NULL,
    "trim_id" VARCHAR(64),
    "engine_id" VARCHAR(64),
    "transmission" "VehicleTransmission",
    "drivetrain" "Drivetrain",
    "color_hex" VARCHAR(9),
    "vin" VARCHAR(50),
    "license_plate" VARCHAR(20),
    "registration_region_code" VARCHAR(10),
    "mileage_km" INTEGER,
    "fuel_type" "FuelType",
    "model_3d_asset_id" VARCHAR(64),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_status_events" (
    "id" VARCHAR(64) NOT NULL,
    "vehicle_id" VARCHAR(64) NOT NULL,
    "stage" "VehicleServiceStage" NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "note" TEXT,
    "mechanic_name" VARCHAR(120),
    "emitted_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_providers" (
    "id" VARCHAR(64) NOT NULL,
    "provider_type" "ProviderType" NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "shop_name" VARCHAR(160),
    "bio" TEXT,
    "avatar_url" TEXT,
    "rating_avg" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "geo_lat" DOUBLE PRECISION NOT NULL,
    "geo_lng" DOUBLE PRECISION NOT NULL,
    "geohash" VARCHAR(12) NOT NULL,
    "address_text" TEXT,
    "price_floor_uzs" DECIMAL(14,2),
    "price_ceiling_uzs" DECIMAL(14,2),
    "badge" VARCHAR(40),
    "contact_phone_e164" VARCHAR(20),
    "contact_telegram" VARCHAR(80),
    "contact_website" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_specializations" (
    "provider_id" VARCHAR(64) NOT NULL,
    "specialization" "Specialization" NOT NULL,

    CONSTRAINT "provider_specializations_pkey" PRIMARY KEY ("provider_id","specialization")
);

-- CreateTable
CREATE TABLE "provider_supported_makes" (
    "provider_id" VARCHAR(64) NOT NULL,
    "make_id" VARCHAR(64) NOT NULL,

    CONSTRAINT "provider_supported_makes_pkey" PRIMARY KEY ("provider_id","make_id")
);

-- CreateTable
CREATE TABLE "provider_service_offerings" (
    "id" VARCHAR(64) NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "duration_min" INTEGER,
    "price_uzs" DECIMAL(14,2) NOT NULL,
    "service_type" VARCHAR(60),

    CONSTRAINT "provider_service_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_working_hours" (
    "id" VARCHAR(64) NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "weekday" INTEGER NOT NULL,
    "open_time" VARCHAR(5),
    "close_time" VARCHAR(5),

    CONSTRAINT "provider_working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_certifications" (
    "id" VARCHAR(64) NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "issued_at" DATE,

    CONSTRAINT "provider_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_portfolio_items" (
    "id" VARCHAR(64) NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "image_url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provider_portfolio_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "vehicle_id" VARCHAR(64),
    "status" "BookingStatus" NOT NULL DEFAULT 'HOLD',
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3),
    "total_uzs" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "contact_phone_e164" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_services" (
    "id" VARCHAR(64) NOT NULL,
    "booking_id" VARCHAR(64) NOT NULL,
    "service_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "price_uzs" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "booking_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_categories" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "parent_id" VARCHAR(64),
    "icon_url" TEXT,

    CONSTRAINT "part_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_brands" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "logo_url" TEXT,

    CONSTRAINT "part_brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_sellers" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "rating_avg" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "logo_url" TEXT,
    "internal_seller_id" INTEGER,

    CONSTRAINT "catalog_sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_parts" (
    "id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "brand_id" VARCHAR(64),
    "category_id" VARCHAR(64) NOT NULL,
    "seller_id" VARCHAR(64) NOT NULL,
    "oem_numbers" TEXT[],
    "gm_numbers" TEXT[],
    "part_number_type" "PartNumberType" NOT NULL DEFAULT 'UNKNOWN',
    "price_uzs" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'UZS',
    "condition" "PartCondition" NOT NULL DEFAULT 'NEW',
    "in_stock" BOOLEAN NOT NULL DEFAULT true,
    "stock_qty" INTEGER NOT NULL DEFAULT 0,
    "delivery_eta_days_min" INTEGER,
    "delivery_eta_days_max" INTEGER,
    "images" TEXT[],
    "main_category" "PartMainCategory",
    "vehicle_category" "PartVehicleCategory",
    "part_brand_name" VARCHAR(120),
    "origin_region" "PartOriginRegion",
    "is_oem" BOOLEAN NOT NULL DEFAULT false,
    "is_gm" BOOLEAN NOT NULL DEFAULT false,
    "is_universal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_part_fits" (
    "part_id" VARCHAR(64) NOT NULL,
    "make_slug" VARCHAR(80) NOT NULL,
    "model_slug" VARCHAR(96) NOT NULL,
    "make_name" VARCHAR(120) NOT NULL,
    "model_name" VARCHAR(120) NOT NULL,

    CONSTRAINT "catalog_part_fits_pkey" PRIMARY KEY ("part_id","model_slug")
);

-- CreateTable
CREATE TABLE "part_compatibilities" (
    "id" VARCHAR(64) NOT NULL,
    "part_id" VARCHAR(64) NOT NULL,
    "trim_id" VARCHAR(64),
    "engine_id" VARCHAR(64),
    "years" INTEGER[],
    "status" "CompatibilityStatus" NOT NULL DEFAULT 'FITS',
    "confidence" DECIMAL(4,3) NOT NULL DEFAULT 1,
    "source" VARCHAR(80),

    CONSTRAINT "part_compatibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "featured_items" (
    "id" VARCHAR(64) NOT NULL,
    "part_id" VARCHAR(64),
    "badge" VARCHAR(40),
    "status" VARCHAR(40),
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "price_uzs" DECIMAL(14,2),
    "model" VARCHAR(120),
    "brand" VARCHAR(120),
    "color" VARCHAR(60),
    "condition" VARCHAR(60),
    "oem" VARCHAR(80),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "featured_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "promo_code" VARCHAR(60),
    "promo_discount_uzs" DECIMAL(14,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" VARCHAR(64) NOT NULL,
    "cart_id" VARCHAR(64) NOT NULL,
    "part_id" VARCHAR(64),
    "service_id" VARCHAR(64),
    "provider_id" VARCHAR(64),
    "vehicle_id" VARCHAR(64),
    "title" VARCHAR(255) NOT NULL,
    "image_url" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "scheduled_at" TIMESTAMPTZ(3),
    "price_uzs_snapshot" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "subtotal_uzs" DECIMAL(14,2) NOT NULL,
    "delivery_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "service_fee_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_uzs" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'UZS',
    "vehicle_id" VARCHAR(64),
    "delivery_address_id" VARCHAR(64),
    "delivery_method" "DeliveryMethod",
    "contact_phone_e164" VARCHAR(20),
    "promo_code" VARCHAR(60),
    "yandex_claim_id" VARCHAR(100),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "part_id" VARCHAR(64),
    "service_id" VARCHAR(64),
    "provider_id" VARCHAR(64),
    "title" VARCHAR(255) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price_uzs" DECIMAL(14,2) NOT NULL,
    "line_total_uzs" DECIMAL(14,2) NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3),

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount_uzs" DECIMAL(14,2) NOT NULL,
    "amount_tiyin" BIGINT,
    "deep_link" TEXT,
    "https_fallback" TEXT,
    "provider_transaction_id" VARCHAR(120),
    "provider_state" INTEGER,
    "provider_create_time" BIGINT,
    "provider_perform_time" BIGINT,
    "provider_cancel_time" BIGINT,
    "cancel_reason" INTEGER,
    "provider_prepare_id" VARCHAR(64),
    "paid_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "install_id" VARCHAR(80) NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "expo_push_token" TEXT,
    "fcm_token" TEXT,
    "apns_token" TEXT,
    "os_version" VARCHAR(40),
    "app_version" VARCHAR(40),
    "device_model" VARCHAR(80),
    "locale" VARCHAR(20),
    "timezone" VARCHAR(60),
    "permissions_granted" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "orders" BOOLEAN NOT NULL DEFAULT true,
    "payments" BOOLEAN NOT NULL DEFAULT true,
    "ai_replies" BOOLEAN NOT NULL DEFAULT true,
    "master_messages" BOOLEAN NOT NULL DEFAULT true,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "quiet_hours_start" VARCHAR(5),
    "quiet_hours_end" VARCHAR(5),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "deeplink_path" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "vehicle_id" VARCHAR(64),
    "locale" VARCHAR(20),
    "entry_point" VARCHAR(60),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" VARCHAR(64) NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "client_message_id" VARCHAR(64),
    "attachments" JSONB,
    "structured" JSONB,
    "token_count" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sellers_tg_id_key" ON "sellers"("tg_id");

-- CreateIndex
CREATE INDEX "sellers_status_idx" ON "sellers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE UNIQUE INDEX "car_models_brand_id_name_key" ON "car_models"("brand_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_gm_number_key" ON "products"("gm_number");

-- CreateIndex
CREATE INDEX "products_main_category_idx" ON "products"("main_category");

-- CreateIndex
CREATE INDEX "products_vehicle_category_idx" ON "products"("vehicle_category");

-- CreateIndex
CREATE INDEX "product_images_product_id_sort_order_idx" ON "product_images"("product_id", "sort_order");

-- CreateIndex
CREATE INDEX "part_models_model_id_idx" ON "part_models"("model_id");

-- CreateIndex
CREATE INDEX "oem_compatibility_oem_number_idx" ON "oem_compatibility"("oem_number");

-- CreateIndex
CREATE UNIQUE INDEX "oem_compatibility_oem_number_make_model_key" ON "oem_compatibility"("oem_number", "make", "model");

-- CreateIndex
CREATE INDEX "stocks_product_id_idx" ON "stocks"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stocks_seller_id_product_id_key" ON "stocks"("seller_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_users_email_key" ON "app_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "app_users_phone_e164_key" ON "app_users"("phone_e164");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_provider_user_id_key" ON "auth_identities"("provider", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_device_id_idx" ON "refresh_tokens"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE INDEX "email_verification_tokens_expires_at_idx" ON "email_verification_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "phone_otp_requests_phone_e164_created_at_idx" ON "phone_otp_requests"("phone_e164", "created_at");

-- CreateIndex
CREATE INDEX "phone_otp_requests_expires_at_idx" ON "phone_otp_requests"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "myid_sessions_state_key" ON "myid_sessions"("state");

-- CreateIndex
CREATE INDEX "myid_sessions_user_id_idx" ON "myid_sessions"("user_id");

-- CreateIndex
CREATE INDEX "myid_verifications_user_id_idx" ON "myid_verifications"("user_id");

-- CreateIndex
CREATE INDEX "myid_verifications_pinfl_idx" ON "myid_verifications"("pinfl");

-- CreateIndex
CREATE INDEX "addresses_user_id_idx" ON "addresses"("user_id");

-- CreateIndex
CREATE INDEX "vehicle_models_make_id_idx" ON "vehicle_models"("make_id");

-- CreateIndex
CREATE INDEX "vehicle_trims_model_id_idx" ON "vehicle_trims"("model_id");

-- CreateIndex
CREATE INDEX "vehicle_3d_assets_trim_id_idx" ON "vehicle_3d_assets"("trim_id");

-- CreateIndex
CREATE INDEX "tuning_variants_asset_id_idx" ON "tuning_variants"("asset_id");

-- CreateIndex
CREATE INDEX "vehicles_user_id_idx" ON "vehicles"("user_id");

-- CreateIndex
CREATE INDEX "vehicles_user_id_is_primary_idx" ON "vehicles"("user_id", "is_primary");

-- CreateIndex
CREATE INDEX "vehicle_status_events_vehicle_id_idx" ON "vehicle_status_events"("vehicle_id");

-- CreateIndex
CREATE INDEX "service_providers_provider_type_idx" ON "service_providers"("provider_type");

-- CreateIndex
CREATE INDEX "service_providers_geohash_idx" ON "service_providers"("geohash");

-- CreateIndex
CREATE INDEX "service_providers_rating_avg_idx" ON "service_providers"("rating_avg");

-- CreateIndex
CREATE INDEX "provider_supported_makes_make_id_idx" ON "provider_supported_makes"("make_id");

-- CreateIndex
CREATE INDEX "provider_service_offerings_provider_id_idx" ON "provider_service_offerings"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_working_hours_provider_id_weekday_key" ON "provider_working_hours"("provider_id", "weekday");

-- CreateIndex
CREATE INDEX "provider_certifications_provider_id_idx" ON "provider_certifications"("provider_id");

-- CreateIndex
CREATE INDEX "provider_portfolio_items_provider_id_idx" ON "provider_portfolio_items"("provider_id");

-- CreateIndex
CREATE INDEX "bookings_user_id_idx" ON "bookings"("user_id");

-- CreateIndex
CREATE INDEX "bookings_provider_id_idx" ON "bookings"("provider_id");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX "booking_services_booking_id_idx" ON "booking_services"("booking_id");

-- CreateIndex
CREATE INDEX "part_categories_parent_id_idx" ON "part_categories"("parent_id");

-- CreateIndex
CREATE INDEX "catalog_sellers_internal_seller_id_idx" ON "catalog_sellers"("internal_seller_id");

-- CreateIndex
CREATE INDEX "catalog_parts_category_id_idx" ON "catalog_parts"("category_id");

-- CreateIndex
CREATE INDEX "catalog_parts_brand_id_idx" ON "catalog_parts"("brand_id");

-- CreateIndex
CREATE INDEX "catalog_parts_seller_id_idx" ON "catalog_parts"("seller_id");

-- CreateIndex
CREATE INDEX "catalog_parts_in_stock_idx" ON "catalog_parts"("in_stock");

-- CreateIndex
CREATE INDEX "catalog_parts_main_category_idx" ON "catalog_parts"("main_category");

-- CreateIndex
CREATE INDEX "catalog_parts_vehicle_category_idx" ON "catalog_parts"("vehicle_category");

-- CreateIndex
CREATE INDEX "catalog_parts_origin_region_idx" ON "catalog_parts"("origin_region");

-- CreateIndex
CREATE INDEX "catalog_parts_is_gm_idx" ON "catalog_parts"("is_gm");

-- CreateIndex
CREATE INDEX "catalog_parts_is_oem_idx" ON "catalog_parts"("is_oem");

-- CreateIndex
CREATE INDEX "catalog_part_fits_make_slug_idx" ON "catalog_part_fits"("make_slug");

-- CreateIndex
CREATE INDEX "catalog_part_fits_model_slug_idx" ON "catalog_part_fits"("model_slug");

-- CreateIndex
CREATE INDEX "part_compatibilities_part_id_idx" ON "part_compatibilities"("part_id");

-- CreateIndex
CREATE INDEX "part_compatibilities_trim_id_idx" ON "part_compatibilities"("trim_id");

-- CreateIndex
CREATE INDEX "part_compatibilities_engine_id_idx" ON "part_compatibilities"("engine_id");

-- CreateIndex
CREATE INDEX "featured_items_is_active_sort_order_idx" ON "featured_items"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "carts_user_id_key" ON "carts"("user_id");

-- CreateIndex
CREATE INDEX "cart_items_cart_id_idx" ON "cart_items"("cart_id");

-- CreateIndex
CREATE INDEX "orders_user_id_idx" ON "orders"("user_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_provider_transaction_id_idx" ON "payments"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_install_id_key" ON "devices"("user_id", "install_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE INDEX "ai_sessions_user_id_idx" ON "ai_sessions"("user_id");

-- CreateIndex
CREATE INDEX "ai_messages_session_id_idx" ON "ai_messages"("session_id");

-- AddForeignKey
ALTER TABLE "car_models" ADD CONSTRAINT "car_models_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_models" ADD CONSTRAINT "part_models_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "car_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_models" ADD CONSTRAINT "part_models_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "myid_sessions" ADD CONSTRAINT "myid_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "myid_verifications" ADD CONSTRAINT "myid_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_make_id_fkey" FOREIGN KEY ("make_id") REFERENCES "vehicle_makes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_trims" ADD CONSTRAINT "vehicle_trims_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "vehicle_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_3d_assets" ADD CONSTRAINT "vehicle_3d_assets_trim_id_fkey" FOREIGN KEY ("trim_id") REFERENCES "vehicle_trims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tuning_variants" ADD CONSTRAINT "tuning_variants_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "vehicle_3d_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_make_id_fkey" FOREIGN KEY ("make_id") REFERENCES "vehicle_makes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "vehicle_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_trim_id_fkey" FOREIGN KEY ("trim_id") REFERENCES "vehicle_trims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_engine_id_fkey" FOREIGN KEY ("engine_id") REFERENCES "vehicle_engines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_model_3d_asset_id_fkey" FOREIGN KEY ("model_3d_asset_id") REFERENCES "vehicle_3d_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_status_events" ADD CONSTRAINT "vehicle_status_events_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_specializations" ADD CONSTRAINT "provider_specializations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_supported_makes" ADD CONSTRAINT "provider_supported_makes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_supported_makes" ADD CONSTRAINT "provider_supported_makes_make_id_fkey" FOREIGN KEY ("make_id") REFERENCES "vehicle_makes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_service_offerings" ADD CONSTRAINT "provider_service_offerings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_working_hours" ADD CONSTRAINT "provider_working_hours_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_certifications" ADD CONSTRAINT "provider_certifications_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_portfolio_items" ADD CONSTRAINT "provider_portfolio_items_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "service_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "service_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_services" ADD CONSTRAINT "booking_services_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_categories" ADD CONSTRAINT "part_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_parts" ADD CONSTRAINT "catalog_parts_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "part_brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_parts" ADD CONSTRAINT "catalog_parts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "part_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_parts" ADD CONSTRAINT "catalog_parts_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "catalog_sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_part_fits" ADD CONSTRAINT "catalog_part_fits_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "catalog_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibilities" ADD CONSTRAINT "part_compatibilities_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "catalog_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibilities" ADD CONSTRAINT "part_compatibilities_trim_id_fkey" FOREIGN KEY ("trim_id") REFERENCES "vehicle_trims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibilities" ADD CONSTRAINT "part_compatibilities_engine_id_fkey" FOREIGN KEY ("engine_id") REFERENCES "vehicle_engines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_address_id_fkey" FOREIGN KEY ("delivery_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

