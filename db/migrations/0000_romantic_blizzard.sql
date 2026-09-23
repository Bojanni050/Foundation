CREATE TYPE "public"."soort_kenmerk" AS ENUM('feit', 'patroon');--> statement-breakpoint
CREATE TYPE "public"."status_markering" AS ENUM('observation', 'hypothesis', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "persona_instelling" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"confidence_threshold" integer DEFAULT 90 NOT NULL,
	"promotie_min_bronnen" integer DEFAULT 2 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_kenmerk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kenmerk" text NOT NULL,
	"soort" "soort_kenmerk" DEFAULT 'patroon' NOT NULL,
	"gevoelig" boolean DEFAULT false NOT NULL,
	"zekerheid" integer DEFAULT 0 NOT NULL,
	"status" "status_markering" DEFAULT 'observation' NOT NULL,
	"bron_object_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"laatst_versterkt_op" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_kenmerk_gebruik" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kenmerk_id" uuid NOT NULL,
	"gebruikt_in_object_id" text NOT NULL,
	"context" text NOT NULL,
	"gebruikt_op" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_kenmerk_gebruik" ADD CONSTRAINT "persona_kenmerk_gebruik_kenmerk_id_persona_kenmerk_id_fk" FOREIGN KEY ("kenmerk_id") REFERENCES "public"."persona_kenmerk"("id") ON DELETE cascade ON UPDATE no action;