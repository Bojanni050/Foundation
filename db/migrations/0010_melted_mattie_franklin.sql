CREATE TYPE "public"."verwerp_bron" AS ENUM('consolidatie', 'mens');--> statement-breakpoint
ALTER TYPE "public"."status_markering" ADD VALUE 'interpretation' BEFORE 'hypothesis';--> statement-breakpoint
ALTER TABLE "persona_kenmerk" ADD COLUMN "verwerp_bron" "verwerp_bron";--> statement-breakpoint
ALTER TABLE "persona_kenmerk" ADD COLUMN "voorganger_id" uuid;--> statement-breakpoint
ALTER TABLE "specialist" ADD COLUMN "verwerp_bron" "verwerp_bron";--> statement-breakpoint
ALTER TABLE "specialist" ADD COLUMN "voorganger_id" uuid;