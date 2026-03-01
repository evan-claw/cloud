CREATE TABLE IF NOT EXISTS `agent_metadata` (
	`bead_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`identity` text NOT NULL,
	`container_process_id` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`current_hook_bead_id` text,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`checkpoint` text,
	`last_activity_at` text,
	FOREIGN KEY (`bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_hook_bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "check_agent_metadata_role" CHECK("agent_metadata"."role" in ('polecat', 'refinery', 'mayor', 'witness')),
	CONSTRAINT "check_agent_metadata_status" CHECK("agent_metadata"."status" in ('idle', 'working', 'stalled', 'dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_metadata_identity_unique` ON `agent_metadata` (`identity`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bead_dependencies` (
	`bead_id` text NOT NULL,
	`depends_on_bead_id` text NOT NULL,
	`dependency_type` text DEFAULT 'blocks' NOT NULL,
	FOREIGN KEY (`bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "check_bead_deps_type" CHECK("bead_dependencies"."dependency_type" in ('blocks', 'tracks', 'parent-child'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_bead_deps_pk` ON `bead_dependencies` (`bead_id`,`depends_on_bead_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bead_deps_depends_on` ON `bead_dependencies` (`depends_on_bead_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bead_events` (
	`bead_event_id` text PRIMARY KEY NOT NULL,
	`bead_id` text NOT NULL,
	`agent_id` text,
	`event_type` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bead_events_bead` ON `bead_events` (`bead_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bead_events_created` ON `bead_events` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bead_events_type` ON `bead_events` (`event_type`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `beads` (
	`bead_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`rig_id` text,
	`parent_bead_id` text,
	`assignee_agent_bead_id` text,
	`priority` text DEFAULT 'medium',
	`labels` text DEFAULT '[]',
	`metadata` text DEFAULT '{}',
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`parent_bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "check_beads_type" CHECK("beads"."type" in ('issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent')),
	CONSTRAINT "check_beads_status" CHECK("beads"."status" in ('open', 'in_progress', 'closed', 'failed')),
	CONSTRAINT "check_beads_priority" CHECK("beads"."priority" in ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_beads_type_status` ON `beads` (`type`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_beads_parent` ON `beads` (`parent_bead_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_beads_rig_status` ON `beads` (`rig_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_beads_assignee` ON `beads` (`assignee_agent_bead_id`,`type`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `convoy_metadata` (
	`bead_id` text PRIMARY KEY NOT NULL,
	`total_beads` integer DEFAULT 0 NOT NULL,
	`closed_beads` integer DEFAULT 0 NOT NULL,
	`landed_at` text,
	FOREIGN KEY (`bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `escalation_metadata` (
	`bead_id` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`category` text,
	`acknowledged` integer DEFAULT 0 NOT NULL,
	`re_escalation_count` integer DEFAULT 0 NOT NULL,
	`acknowledged_at` text,
	FOREIGN KEY (`bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "check_escalation_severity" CHECK("escalation_metadata"."severity" in ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_metadata` (
	`bead_id` text PRIMARY KEY NOT NULL,
	`branch` text NOT NULL,
	`target_branch` text DEFAULT 'main' NOT NULL,
	`merge_commit` text,
	`pr_url` text,
	`retry_count` integer DEFAULT 0,
	FOREIGN KEY (`bead_id`) REFERENCES `beads`(`bead_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rig_agent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`event_type` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rig_agent_events_agent_id` ON `rig_agent_events` (`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rig_agent_events_agent_created` ON `rig_agent_events` (`agent_id`,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rigs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`git_url` text DEFAULT '' NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`config` text DEFAULT '{}',
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_rigs_name` ON `rigs` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_rigs` (
	`id` text PRIMARY KEY NOT NULL,
	`town_id` text NOT NULL,
	`name` text NOT NULL,
	`git_url` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`platform_integration_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_towns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
