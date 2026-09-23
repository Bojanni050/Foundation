CREATE TABLE "ingest_object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_type" text NOT NULL,
	"source" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"source_provider" text,
	"url" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"turns" jsonb,
	"attachments" jsonb,
	"occurred_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"provider_conversation_id" text,
	"status" "status_markering" DEFAULT 'observation' NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_object_provider_conversation_id_unique" ON "ingest_object" USING btree ("provider_conversation_id");
