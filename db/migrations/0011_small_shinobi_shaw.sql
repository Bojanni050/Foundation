CREATE TYPE "public"."categorie" AS ENUM('persona', 'skill', 'algemeen');--> statement-breakpoint
CREATE TYPE "public"."gaia_topic_kind" AS ENUM('contradiction', 'notable_fact');--> statement-breakpoint
CREATE TABLE "gaia_proactive_topic" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "gaia_topic_kind" NOT NULL,
	"summary" text NOT NULL,
	"kenmerk_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "persona_kenmerk" ALTER COLUMN "soort" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "persona_kenmerk" ALTER COLUMN "soort" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_kenmerk" ADD COLUMN "categorie" "categorie" DEFAULT 'persona' NOT NULL;