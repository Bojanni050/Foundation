ALTER TABLE "ingest_object" ADD COLUMN "memory_processed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ingest_object_pending_memory_idx" ON "ingest_object" USING btree ("ingested_at") WHERE "memory_processed_at" IS NULL;
