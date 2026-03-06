ALTER TABLE "contributor_champion_memberships" ADD COLUMN "credit_amount_microdollars" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contributor_champion_memberships" ADD COLUMN "credits_last_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contributor_champion_memberships" ADD COLUMN "linked_kilo_user_id" text REFERENCES "kilocode_users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_memberships_credits_due" ON "contributor_champion_memberships" ("credits_last_granted_at") WHERE enrolled_tier IS NOT NULL AND credit_amount_microdollars > 0;
