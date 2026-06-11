-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "uploadedById" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "permissions" JSONB;

-- CreateIndex
CREATE INDEX "documents_uploadedById_idx" ON "documents"("uploadedById");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
