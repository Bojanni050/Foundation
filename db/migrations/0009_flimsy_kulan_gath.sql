CREATE TABLE "specialist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"onderwerp" text NOT NULL,
	"status" "status_markering" DEFAULT 'observation' NOT NULL,
	"bron_object_ids" text[] DEFAULT '{}' NOT NULL,
	"system_prompt" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
