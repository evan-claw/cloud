ALTER TABLE "contributor_champion_contributors" ADD COLUMN "manual_email" text;--> statement-breakpoint
CREATE INDEX "IDX_contributor_champion_contributors_manual_email" ON "contributor_champion_contributors" USING btree ("manual_email");
