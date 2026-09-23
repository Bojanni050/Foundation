ALTER TABLE "fact" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fact" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fact" ADD COLUMN "temporal_text" text;--> statement-breakpoint
ALTER TABLE "fact" ADD COLUMN "supersedes_fact_id" uuid;--> statement-breakpoint
ALTER TABLE "hypothesis" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hypothesis" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hypothesis" ADD COLUMN "temporal_text" text;--> statement-breakpoint
ALTER TABLE "hypothesis" ADD COLUMN "supersedes_fact_id" uuid;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_supersedes_fact_id_fact_id_fk" FOREIGN KEY ("supersedes_fact_id") REFERENCES "public"."fact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypothesis" ADD CONSTRAINT "hypothesis_supersedes_fact_id_fact_id_fk" FOREIGN KEY ("supersedes_fact_id") REFERENCES "public"."fact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_supersedes_fact_id_unique" ON "fact" USING btree ("supersedes_fact_id");