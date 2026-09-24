CREATE TABLE "integration_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hindsight_url" text,
	"hindsight_bank_id" text,
	"reflection_llm_base_url" text,
	"reflection_llm_model" text,
	"reflection_llm_api_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
