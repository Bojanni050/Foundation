CREATE TYPE "public"."evidence_direction" AS ENUM('supporting', 'contradicting', 'contextualizing');--> statement-breakpoint
CREATE TYPE "public"."hypothesis_status" AS ENUM('open', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."knowledge_gap_status" AS ENUM('unknown', 'not_asked', 'known_absent', 'resolved');--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hypothesis_id" uuid NOT NULL,
	"richting" "evidence_direction" NOT NULL,
	"bronsoort" text NOT NULL,
	"fragment" text NOT NULL,
	"spreker" text,
	"tijdstip" timestamp with time zone,
	"bron_object_id" text NOT NULL,
	"bron_referentie" text,
	"conversation_identity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypothesis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hypothese" text NOT NULL,
	"verificatie_criteria" text,
	"bevestigings_criteria" text,
	"afwijzings_criteria" text,
	"status" "hypothesis_status" DEFAULT 'open' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"verwerp_reden" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_gap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"onderwerp" text NOT NULL,
	"status" "knowledge_gap_status" DEFAULT 'unknown' NOT NULL,
	"hypothesis_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_hypothesis_id_hypothesis_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypothesis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gap" ADD CONSTRAINT "knowledge_gap_hypothesis_id_hypothesis_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypothesis"("id") ON DELETE set null ON UPDATE no action;