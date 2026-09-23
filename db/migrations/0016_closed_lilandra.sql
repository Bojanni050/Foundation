CREATE TABLE "fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inhoud" text NOT NULL,
	"hypothesis_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_hypothesis_id_hypothesis_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypothesis"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_hypothesis_id_unique" ON "fact" USING btree ("hypothesis_id");--> statement-breakpoint

-- Database-level append-only enforcement, same reasoning and pattern as
-- episode's own trigger (migration 0014): there is intentionally no update
-- or delete API for a fact, but the invariant belongs in PostgreSQL too.
CREATE FUNCTION "prevent_fact_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'fact is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "fact_append_only"
BEFORE UPDATE OR DELETE ON "fact"
FOR EACH ROW EXECUTE FUNCTION "prevent_fact_mutation"();