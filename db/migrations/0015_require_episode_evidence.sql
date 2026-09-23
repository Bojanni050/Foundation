ALTER TABLE "evidence" ALTER COLUMN "episode_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "bronsoort";--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "fragment";--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "spreker";--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "tijdstip";--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "bron_object_id";--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "bron_referentie";--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "conversation_identity";