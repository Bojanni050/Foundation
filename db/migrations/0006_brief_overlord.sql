CREATE TABLE "persona_pulse_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"items" text[] NOT NULL,
	"ai_used" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_instelling" ADD COLUMN "skepticism" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_instelling" ADD COLUMN "literalism" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_instelling" ADD COLUMN "empathy" integer DEFAULT 3 NOT NULL;