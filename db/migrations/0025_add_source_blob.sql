CREATE TABLE "source_blob" (
	"hash" text PRIMARY KEY NOT NULL,
	"ingest_object_id" uuid NOT NULL,
	"size" bigint NOT NULL,
	"filename" text,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
