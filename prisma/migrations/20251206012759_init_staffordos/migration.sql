-- CreateEnum
CREATE TYPE "AbandoPlanTier" AS ENUM ('free', 'starter', 'growth', 'enterprise');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('healthy', 'watch', 'broken', 'inactive');

-- CreateEnum
CREATE TYPE "DailyStatusFlag" AS ENUM ('ok', 'warning', 'error');

-- CreateTable
CREATE TABLE "AbandoMerchant" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "planTier" "AbandoPlanTier" NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL,
    "uninstalledAt" TIMESTAMP(3),
    "status" "MerchantStatus" NOT NULL DEFAULT 'healthy',
    "lastSeenAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbandoMerchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbandoMerchantDailyStat" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "cartsTotal" INTEGER NOT NULL,
    "cartsAbandoned" INTEGER NOT NULL,
    "cartsRecovered" INTEGER NOT NULL,
    "recoveryRate" DOUBLE PRECISION NOT NULL,
    "revenueRecoveredCents" INTEGER NOT NULL,
    "exportOk" BOOLEAN NOT NULL,
    "errorsCount" INTEGER NOT NULL,
    "statusFlag" "DailyStatusFlag" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbandoMerchantDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AbandoMerchant_shopDomain_key" ON "AbandoMerchant"("shopDomain");

-- CreateIndex
CREATE INDEX "AbandoMerchantDailyStat_date_idx" ON "AbandoMerchantDailyStat"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AbandoMerchantDailyStat_merchantId_date_key" ON "AbandoMerchantDailyStat"("merchantId", "date");

-- AddForeignKey
ALTER TABLE "AbandoMerchantDailyStat" ADD CONSTRAINT "AbandoMerchantDailyStat_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "AbandoMerchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
