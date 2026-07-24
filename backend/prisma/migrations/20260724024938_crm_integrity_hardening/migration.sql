/*
  Warnings:

  - You are about to drop the column `external_id` on the `lead_attributions` table. All the data in the column will be lost.
  - Added the required column `received_at` to the `ingestion_receipts` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "deal_activities" DROP CONSTRAINT "deal_activities_deal_id_fkey";

-- DropForeignKey
ALTER TABLE "ingestion_receipts" DROP CONSTRAINT "ingestion_receipts_deal_id_fkey";

-- DropIndex
DROP INDEX "deal_activities_kind_created_at_idx";

-- DropIndex
DROP INDEX "ingestion_receipts_deal_id_idx";

-- AlterTable
ALTER TABLE "deal_activities" ADD COLUMN     "from_stage" "deal_stage",
ADD COLUMN     "to_stage" "deal_stage";

-- AlterTable
ALTER TABLE "ingestion_receipts" ADD COLUMN     "received_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "lead_attributions" DROP COLUMN "external_id";

-- CreateIndex
CREATE INDEX "deal_activities_kind_created_at_stage_idx" ON "deal_activities"("kind", "created_at", "from_stage", "to_stage");

-- AddForeignKey
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
