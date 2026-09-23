ALTER TABLE "chat_message" RENAME TO "object_chunk";--> statement-breakpoint
ALTER TABLE "object_chunk" DROP COLUMN "role";--> statement-breakpoint
DROP TYPE "public"."chat_role";