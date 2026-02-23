CREATE TABLE "kiloclaw_available_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"openclaw_version" text NOT NULL,
	"variant" text DEFAULT 'default' NOT NULL,
	"image_tag" text NOT NULL,
	"image_digest" text,
	"is_latest" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiloclaw_available_versions_status_check" CHECK ("kiloclaw_available_versions"."status" IN ('active', 'deprecated', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "kiloclaw_version_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"image_tag" text NOT NULL,
	"pinned_by" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiloclaw_available_versions" ADD CONSTRAINT "kiloclaw_available_versions_published_by_kilocode_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiloclaw_version_pins" ADD CONSTRAINT "kiloclaw_version_pins_pinned_by_kilocode_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."kilocode_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_available_versions_image_tag" ON "kiloclaw_available_versions" USING btree ("image_tag");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_available_versions_image_digest" ON "kiloclaw_available_versions" USING btree ("image_digest") WHERE image_digest IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_available_versions_latest_variant" ON "kiloclaw_available_versions" USING btree ("variant") WHERE is_latest = true;--> statement-breakpoint
CREATE INDEX "IDX_kiloclaw_available_versions_status_variant" ON "kiloclaw_available_versions" USING btree ("status","variant");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_kiloclaw_version_pins_user" ON "kiloclaw_version_pins" USING btree ("user_id");