/**
 * Shared types for the Town DO.
 */

export type FailureReason = {
  code: string; // machine-readable: 'dispatch_exhausted', 'agent_crashed', 'timeout', 'orphaned_work', 'missing_rig_id', 'missing_rig_config', 'container_start_failed', 'admin_force_fail'
  message: string; // human-readable summary
  details?: string; // optional: stack trace, error output, container logs
  source: string; // what triggered it: 'scheduler', 'patrol', 'refinery', 'triage', 'admin', 'container'
};
