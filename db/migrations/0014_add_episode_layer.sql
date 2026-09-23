CREATE TYPE "public"."episode_source_type" AS ENUM('chat-import', 'document', 'explicit-input', 'system-observation');--> statement-breakpoint
CREATE TABLE "episode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bron_object_id" text NOT NULL,
	"bronsoort" text NOT NULL,
	"fragment" text NOT NULL,
	"spreker" text,
	"observed_at" timestamp with time zone,
	"bron_referentie" text,
	"conversation_identity" text,
	"source_type" "episode_source_type" NOT NULL,
	"extraction_confidence" integer,
	"context_window" text,
	"observation_hash" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episode_extraction_confidence_range" CHECK ("episode"."extraction_confidence" IS NULL OR ("episode"."extraction_confidence" >= 0 AND "episode"."extraction_confidence" <= 100))
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "episode_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "episode_observation_hash_unique" ON "episode" USING btree ("observation_hash");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_episode_id_episode_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episode"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_hypothesis_episode_unique" ON "evidence" USING btree ("hypothesis_id","episode_id");--> statement-breakpoint

-- Lossless backfill: preserve one immutable episode per legacy evidence row.
-- Deliberately do not deduplicate historical rows during a structural
-- migration; later tooling can compare them without risking provenance loss.
INSERT INTO "episode" (
	"bron_object_id",
	"bronsoort",
	"fragment",
	"spreker",
	"observed_at",
	"bron_referentie",
	"conversation_identity",
	"source_type",
	"observation_hash",
	"captured_at"
)
SELECT
	"bron_object_id",
	"bronsoort",
	"fragment",
	"spreker",
	"tijdstip",
	"bron_referentie",
	"conversation_identity",
	'explicit-input'::"episode_source_type",
	'legacy:' || "id"::text,
	"created_at"
FROM "evidence";--> statement-breakpoint

UPDATE "evidence" AS e
SET "episode_id" = ep."id"
FROM "episode" AS ep
WHERE ep."observation_hash" = 'legacy:' || e."id"::text;--> statement-breakpoint

-- Database-level append-only enforcement. There is intentionally no update
-- or delete API, but the invariant belongs in PostgreSQL as well.
CREATE FUNCTION "prevent_episode_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'episode is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "episode_append_only"
BEFORE UPDATE OR DELETE ON "episode"
FOR EACH ROW EXECUTE FUNCTION "prevent_episode_mutation"();
