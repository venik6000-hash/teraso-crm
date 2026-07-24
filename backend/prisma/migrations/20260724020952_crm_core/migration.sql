-- CreateEnum
CREATE TYPE "deal_stage" AS ENUM ('NEW', 'QUALIFIED', 'PROPOSAL_SENT', 'PREPAYMENT', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "lead_class" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "task_kind" AS ENUM ('CALL', 'MESSAGE', 'CLARIFY', 'OTHER');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "loss_reason" AS ENUM ('WRONG_NUMBER', 'NO_ANSWER', 'INAPPROPRIATE', 'IGNORED_AFTER_CALL', 'IGNORED_AFTER_SCORING', 'CURIOSITY', 'CHOSEN_COMPETITOR', 'NEED_DISAPPEARED');

-- CreateEnum
CREATE TYPE "material" AS ENUM ('WPC', 'WOOD', 'FACADE');

-- CreateEnum
CREATE TYPE "preferred_channel" AS ENUM ('CALL', 'TELEGRAM', 'WHATSAPP', 'VIBER');

-- CreateEnum
CREATE TYPE "deal_activity_kind" AS ENUM ('DEAL_CREATED', 'INBOUND_LEAD_RECEIVED', 'FIELD_UPDATED', 'STAGE_CHANGED', 'REOPENED', 'NOTE_ADDED', 'TASK_CREATED', 'TASK_COMPLETED', 'TASK_CANCELLED', 'TASK_RESCHEDULED');

-- CreateEnum
CREATE TYPE "notification_kind" AS ENUM ('NEW_LEAD', 'TASK_DUE', 'TASK_OVERDUE', 'LEAD_NEEDS_ACTION');

-- CreateEnum
CREATE TYPE "notification_delivery_state" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "phone_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "client_id" UUID NOT NULL,
    "stage" "deal_stage" NOT NULL DEFAULT 'NEW',
    "lead_class" "lead_class",
    "loss_reason" "loss_reason",
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "form" TEXT,
    "landing_url" TEXT,
    "responsible_user_id" UUID,
    "material" "material",
    "area_label" TEXT,
    "budget_label" TEXT,
    "object_type" TEXT,
    "need_timing" TEXT,
    "preferred_channel" "preferred_channel",
    "potential_amount" DECIMAL(14,2),
    "prepayment_amount" DECIMAL(14,2),
    "prepayment_paid_at" TIMESTAMP(3),
    "full_payment_amount" DECIMAL(14,2),
    "full_payment_paid_at" TIMESTAMP(3),
    "current_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "deal_id" UUID NOT NULL,
    "kind" "task_kind" NOT NULL,
    "title" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" "task_status" NOT NULL DEFAULT 'ACTIVE',
    "assignee_user_id" UUID,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_activities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "deal_id" UUID NOT NULL,
    "kind" "deal_activity_kind" NOT NULL,
    "text" TEXT,
    "author_user_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_attributions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "deal_id" UUID NOT NULL,
    "external_id" TEXT,
    "meta_event_id" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "gclid" TEXT,
    "gbraid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_receipts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "deal_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "recipient_user_id" UUID NOT NULL,
    "deal_id" UUID,
    "kind" "notification_kind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "delivery_state" "notification_delivery_state" NOT NULL DEFAULT 'PENDING',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_phone_normalized_key" ON "clients"("phone_normalized");

-- CreateIndex
CREATE INDEX "deals_stage_submitted_at_idx" ON "deals"("stage", "submitted_at");

-- CreateIndex
CREATE INDEX "deals_client_id_idx" ON "deals"("client_id");

-- CreateIndex
CREATE INDEX "deals_responsible_user_id_idx" ON "deals"("responsible_user_id");

-- CreateIndex
CREATE INDEX "deals_submitted_at_idx" ON "deals"("submitted_at");

-- CreateIndex
CREATE INDEX "deals_source_idx" ON "deals"("source");

-- CreateIndex
CREATE INDEX "deal_tasks_status_due_at_idx" ON "deal_tasks"("status", "due_at");

-- CreateIndex
CREATE INDEX "deal_tasks_deal_id_status_due_at_idx" ON "deal_tasks"("deal_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "deal_tasks_assignee_user_id_status_idx" ON "deal_tasks"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "deal_activities_deal_id_created_at_idx" ON "deal_activities"("deal_id", "created_at");

-- CreateIndex
CREATE INDEX "deal_activities_kind_created_at_idx" ON "deal_activities"("kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_attributions_deal_id_key" ON "lead_attributions"("deal_id");

-- CreateIndex
CREATE INDEX "lead_attributions_utm_source_idx" ON "lead_attributions"("utm_source");

-- CreateIndex
CREATE INDEX "ingestion_receipts_deal_id_idx" ON "ingestion_receipts"("deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_receipts_source_external_id_key" ON "ingestion_receipts"("source", "external_id");

-- CreateIndex
CREATE INDEX "notifications_event_key_idx" ON "notifications"("event_key");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_read_at_created_at_idx" ON "notifications"("recipient_user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_delivery_state_created_at_idx" ON "notifications"("delivery_state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipient_user_id_event_key_key" ON "notifications"("recipient_user_id", "event_key");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_tasks" ADD CONSTRAINT "deal_tasks_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_tasks" ADD CONSTRAINT "deal_tasks_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
