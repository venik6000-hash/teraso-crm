-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('user', 'admin');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'user',
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");
