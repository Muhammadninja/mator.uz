-- CreateEnum
CREATE TYPE "FitmentStatus" AS ENUM ('EXACT_MATCH', 'MAYBE', 'UNIVERSAL');

-- CreateEnum
CREATE TYPE "NodeCategory" AS ENUM ('ENGINE', 'FRONT_BRAKES', 'REAR_BRAKES', 'SUSPENSION', 'TRANSMISSION', 'ELECTRICAL', 'EXHAUST');

-- CreateTable
CREATE TABLE "vehicle_nodes" (
    "id" TEXT NOT NULL,
    "category" "NodeCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "positionX" DOUBLE PRECISION NOT NULL,
    "positionY" DOUBLE PRECISION NOT NULL,
    "positionZ" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "vehicle_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fitment_bindings" (
    "id" TEXT NOT NULL,
    "partId" VARCHAR(64) NOT NULL,
    "vehicleModelId" VARCHAR(64) NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" "FitmentStatus" NOT NULL DEFAULT 'EXACT_MATCH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fitment_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_nodes_category_key" ON "vehicle_nodes"("category");

-- CreateIndex
CREATE INDEX "fitment_bindings_vehicleModelId_nodeId_idx" ON "fitment_bindings"("vehicleModelId", "nodeId");

-- CreateIndex
CREATE INDEX "fitment_bindings_partId_idx" ON "fitment_bindings"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "fitment_bindings_partId_vehicleModelId_nodeId_key" ON "fitment_bindings"("partId", "vehicleModelId", "nodeId");

-- AddForeignKey
ALTER TABLE "fitment_bindings" ADD CONSTRAINT "fitment_bindings_partId_fkey" FOREIGN KEY ("partId") REFERENCES "catalog_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitment_bindings" ADD CONSTRAINT "fitment_bindings_vehicleModelId_fkey" FOREIGN KEY ("vehicleModelId") REFERENCES "vehicle_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitment_bindings" ADD CONSTRAINT "fitment_bindings_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vehicle_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

