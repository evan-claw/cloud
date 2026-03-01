import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// TownDO tables
// ---------------------------------------------------------------------------

// 1. beads
export const beads = sqliteTable(
  'beads',
  {
    bead_id: text('bead_id').primaryKey(),
    type: text('type', {
      enum: ['issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent'],
    }).notNull(),
    status: text('status', {
      enum: ['open', 'in_progress', 'closed', 'failed'],
    })
      .notNull()
      .default('open'),
    title: text('title').notNull(),
    body: text('body'),
    rig_id: text('rig_id'),
    parent_bead_id: text('parent_bead_id').references((): any => beads.bead_id), // self-ref requires any — drizzle limitation
    assignee_agent_bead_id: text('assignee_agent_bead_id'),
    priority: text('priority', {
      enum: ['low', 'medium', 'high', 'critical'],
    }).default('medium'),
    labels: text('labels').default('[]'),
    metadata: text('metadata').default('{}'),
    created_by: text('created_by'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    closed_at: text('closed_at'),
  },
  table => [
    index('idx_beads_type_status').on(table.type, table.status),
    index('idx_beads_parent').on(table.parent_bead_id),
    index('idx_beads_rig_status').on(table.rig_id, table.status),
    index('idx_beads_assignee').on(table.assignee_agent_bead_id, table.type, table.status),
    check(
      'check_beads_type',
      sql`${table.type} in ('issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent')`
    ),
    check(
      'check_beads_status',
      sql`${table.status} in ('open', 'in_progress', 'closed', 'failed')`
    ),
    check('check_beads_priority', sql`${table.priority} in ('low', 'medium', 'high', 'critical')`),
  ]
);

// 2. bead_events
export const bead_events = sqliteTable(
  'bead_events',
  {
    bead_event_id: text('bead_event_id').primaryKey(),
    bead_id: text('bead_id').notNull(),
    agent_id: text('agent_id'),
    event_type: text('event_type').notNull(),
    old_value: text('old_value'),
    new_value: text('new_value'),
    metadata: text('metadata').default('{}'),
    created_at: text('created_at').notNull(),
  },
  table => [
    index('idx_bead_events_bead').on(table.bead_id),
    index('idx_bead_events_created').on(table.created_at),
    index('idx_bead_events_type').on(table.event_type),
  ]
);

// 3. bead_dependencies (no explicit primary key)
export const bead_dependencies = sqliteTable(
  'bead_dependencies',
  {
    bead_id: text('bead_id')
      .notNull()
      .references(() => beads.bead_id),
    depends_on_bead_id: text('depends_on_bead_id')
      .notNull()
      .references(() => beads.bead_id),
    dependency_type: text('dependency_type', {
      enum: ['blocks', 'tracks', 'parent-child'],
    })
      .notNull()
      .default('blocks'),
  },
  table => [
    uniqueIndex('idx_bead_deps_pk').on(table.bead_id, table.depends_on_bead_id),
    index('idx_bead_deps_depends_on').on(table.depends_on_bead_id),
    check(
      'check_bead_deps_type',
      sql`${table.dependency_type} in ('blocks', 'tracks', 'parent-child')`
    ),
  ]
);

// 4. agent_metadata
export const agent_metadata = sqliteTable(
  'agent_metadata',
  {
    bead_id: text('bead_id')
      .primaryKey()
      .references(() => beads.bead_id),
    role: text('role', {
      enum: ['polecat', 'refinery', 'mayor', 'witness'],
    }).notNull(),
    identity: text('identity').notNull().unique(),
    container_process_id: text('container_process_id'),
    status: text('status', {
      enum: ['idle', 'working', 'stalled', 'dead'],
    })
      .notNull()
      .default('idle'),
    current_hook_bead_id: text('current_hook_bead_id').references(() => beads.bead_id),
    dispatch_attempts: integer('dispatch_attempts').notNull().default(0),
    checkpoint: text('checkpoint'),
    last_activity_at: text('last_activity_at'),
  },
  table => [
    check(
      'check_agent_metadata_role',
      sql`${table.role} in ('polecat', 'refinery', 'mayor', 'witness')`
    ),
    check(
      'check_agent_metadata_status',
      sql`${table.status} in ('idle', 'working', 'stalled', 'dead')`
    ),
  ]
);

// 5. review_metadata
export const review_metadata = sqliteTable('review_metadata', {
  bead_id: text('bead_id')
    .primaryKey()
    .references(() => beads.bead_id),
  branch: text('branch').notNull(),
  target_branch: text('target_branch').notNull().default('main'),
  merge_commit: text('merge_commit'),
  pr_url: text('pr_url'),
  retry_count: integer('retry_count').default(0),
});

// 6. escalation_metadata
export const escalation_metadata = sqliteTable(
  'escalation_metadata',
  {
    bead_id: text('bead_id')
      .primaryKey()
      .references(() => beads.bead_id),
    severity: text('severity', {
      enum: ['low', 'medium', 'high', 'critical'],
    }).notNull(),
    category: text('category'),
    acknowledged: integer('acknowledged').notNull().default(0),
    re_escalation_count: integer('re_escalation_count').notNull().default(0),
    acknowledged_at: text('acknowledged_at'),
  },
  table => [
    check(
      'check_escalation_severity',
      sql`${table.severity} in ('low', 'medium', 'high', 'critical')`
    ),
  ]
);

// 7. convoy_metadata
export const convoy_metadata = sqliteTable('convoy_metadata', {
  bead_id: text('bead_id')
    .primaryKey()
    .references(() => beads.bead_id),
  total_beads: integer('total_beads').notNull().default(0),
  closed_beads: integer('closed_beads').notNull().default(0),
  landed_at: text('landed_at'),
});

// 8. rigs
export const rigs = sqliteTable(
  'rigs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    git_url: text('git_url').notNull().default(''),
    default_branch: text('default_branch').notNull().default('main'),
    config: text('config').default('{}'),
    created_at: text('created_at').notNull(),
  },
  table => [uniqueIndex('idx_rigs_name').on(table.name)]
);

// ---------------------------------------------------------------------------
// GastownUserDO tables
// ---------------------------------------------------------------------------

// 9. user_towns
export const user_towns = sqliteTable('user_towns', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  owner_user_id: text('owner_user_id').notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

// 10. user_rigs
export const user_rigs = sqliteTable('user_rigs', {
  id: text('id').primaryKey(),
  town_id: text('town_id').notNull(),
  name: text('name').notNull(),
  git_url: text('git_url').notNull(),
  default_branch: text('default_branch').notNull().default('main'),
  platform_integration_id: text('platform_integration_id'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

// ---------------------------------------------------------------------------
// AgentDO tables
// ---------------------------------------------------------------------------

// 11. rig_agent_events
export const rig_agent_events = sqliteTable(
  'rig_agent_events',
  {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    agent_id: text('agent_id').notNull(),
    event_type: text('event_type').notNull(),
    data: text('data').notNull().default('{}'),
    created_at: text('created_at').notNull(),
  },
  table => [
    index('idx_rig_agent_events_agent_id').on(table.agent_id),
    index('idx_rig_agent_events_agent_created').on(table.agent_id, table.id),
  ]
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type BeadsSelect = typeof beads.$inferSelect;
export type BeadsInsert = typeof beads.$inferInsert;

export type BeadEventsSelect = typeof bead_events.$inferSelect;
export type BeadEventsInsert = typeof bead_events.$inferInsert;

export type BeadDependenciesSelect = typeof bead_dependencies.$inferSelect;
export type BeadDependenciesInsert = typeof bead_dependencies.$inferInsert;

export type AgentMetadataSelect = typeof agent_metadata.$inferSelect;
export type AgentMetadataInsert = typeof agent_metadata.$inferInsert;

export type ReviewMetadataSelect = typeof review_metadata.$inferSelect;
export type ReviewMetadataInsert = typeof review_metadata.$inferInsert;

export type EscalationMetadataSelect = typeof escalation_metadata.$inferSelect;
export type EscalationMetadataInsert = typeof escalation_metadata.$inferInsert;

export type ConvoyMetadataSelect = typeof convoy_metadata.$inferSelect;
export type ConvoyMetadataInsert = typeof convoy_metadata.$inferInsert;

export type RigsSelect = typeof rigs.$inferSelect;
export type RigsInsert = typeof rigs.$inferInsert;

export type UserTownsSelect = typeof user_towns.$inferSelect;
export type UserTownsInsert = typeof user_towns.$inferInsert;

export type UserRigsSelect = typeof user_rigs.$inferSelect;
export type UserRigsInsert = typeof user_rigs.$inferInsert;

export type RigAgentEventsSelect = typeof rig_agent_events.$inferSelect;
export type RigAgentEventsInsert = typeof rig_agent_events.$inferInsert;
