ALTER TABLE "persona_kenmerk" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "persona_kenmerk" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "persona_kenmerk" ADD COLUMN "temporal_text" text;