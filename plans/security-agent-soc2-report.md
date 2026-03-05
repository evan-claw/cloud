# Implementation Plan: Security Agent SOC2 Compliance Report

SOC2-ready PDF report generation, audit log browsing UI, and compliance metrics for the Security Agent feature.

---

## Background & Motivation

Users of the Security Agent configure SLA targets, sync vulnerability findings from GitHub Dependabot, and rely on the system to triage, analyze, and dismiss non-exploitable findings. The system captures an append-only audit log of every action taken. Users need to produce evidence of this vulnerability management program for SOC2 Type II audits.

Today the data layer is complete — findings, SLA timestamps, analysis results, dismissal evidence, and audit trail are all captured — but there is **no way for users to**:

1. Browse/filter/search the security audit log in the UI (the backend API exists but has zero UI consumers)
2. Generate a SOC2-ready compliance report from this data
3. View SLA compliance metrics (MTTR, % within SLA, overdue counts)

This plan adds all three capabilities.

---

## SOC2 Research Summary

### Relevant Trust Services Criteria

| Criterion   | Title                                     | How the Security Agent Maps                                    |
| ----------- | ----------------------------------------- | -------------------------------------------------------------- |
| CC7.1       | Detection & monitoring of vulnerabilities | Dependabot sync, vulnerability scanning, finding creation      |
| CC7.2       | Monitoring for anomalies/security events  | Continuous sync, auto-analysis pipeline                        |
| CC7.3       | Evaluation of security events             | Three-tier triage/analysis, exploitability assessment          |
| CC7.4       | Incident response & remediation           | SLA-driven remediation, dismissals with evidence               |
| CC3.1–CC3.3 | Risk assessment                           | Severity-based prioritization, CVSS scoring, contextual triage |
| CC5         | Control activities                        | SLA policy definition, configuration management                |

### What Auditors Expect as Evidence

1. **Defined SLA policy** — Written remediation timelines per severity, consistently met
2. **Vulnerability inventory** — Complete list of findings discovered during the reporting period
3. **Remediation evidence** — Findings fixed within SLA with timestamps proving compliance
4. **SLA compliance metrics** — % findings remediated within SLA, MTTR per severity
5. **Exception/dismissal documentation** — Reason, mitigating analysis, who approved
6. **Triage & prioritization evidence** — Showing intelligent assessment beyond raw CVSS
7. **Immutable audit trail** — Every action timestamped and attributed to an actor
8. **Summary metrics** — MTTR, vulnerability age distribution, trend over time

### What We Already Have

| Requirement                | Existing Data                                                      | Status   |
| -------------------------- | ------------------------------------------------------------------ | -------- |
| SLA policy                 | `SecurityAgentConfig` with `sla_*_days` fields                     | Complete |
| Findings inventory         | `security_findings` table with full metadata                       | Complete |
| SLA due dates              | `sla_due_at` per finding, computed from config                     | Complete |
| Remediation timestamps     | `fixed_at`, `created_at`, `first_detected_at`                      | Complete |
| Dismissal evidence         | `ignored_reason`, `ignored_by`, `status='ignored'`                 | Complete |
| Triage/analysis            | `analysis` JSONB with exploitability, suggested action, confidence | Complete |
| Audit trail                | `security_audit_log` with 14 action types, before/after state      | Complete |
| Raw export                 | CSV/JSON export endpoint (max 10K rows)                            | Complete |
| **Report aggregation**     | Individual data exists, **no aggregation endpoint**                | Gap      |
| **Audit log UI**           | Backend API exists, **zero UI components**                         | Gap      |
| **SLA compliance metrics** | Can be computed from existing data, **no endpoint**                | Gap      |

---

## Conventions

### Timestamps and Timezones

All period boundaries, metric calculations, and report timestamps use **UTC**. This is consistent with the existing `timestamptz` columns in the database and all existing Security Agent timestamps (`first_detected_at`, `fixed_at`, `sla_due_at`, `created_at`). The date range picker in the UI accepts dates and converts to UTC start-of-day / end-of-day boundaries.

### Evidence Traceability

Every row in every report table must include source record identifiers so auditors can trace evidence back to the system of record:

- Remediation evidence rows include `finding_id` and `audit_log.id` of the status-change event
- Dismissal log rows include `finding_id`, `audit_log.id` of the dismissal event, and `actor_id`
- Analysis summary rows include `finding_id`
- Audit trail rows include `audit_log.id`

### Empty/Sparse Data Handling

If a section has no data for the reporting period (e.g., no findings were fixed, no dismissals occurred), the section renders a brief explanatory note (e.g., "No findings were remediated during this period.") rather than a blank page or omitting the section entirely. The section heading and structure remain so auditors see the complete report template.

### Audit Trail for Report Generation

A new `SecurityAuditLogAction` value is required:

```
ComplianceReportGenerated = 'security.compliance_report.generated'
```

This is logged when a user downloads a compliance report, recording the reporting period, format, and row counts in metadata. This ensures the report generation itself appears in the audit trail.

### Access Control

Follows the established security agent permission model:

**Personal (user) context:**

- All authenticated users can view their own audit log and compliance metrics (`baseProcedure`).
- All authenticated users can download their own compliance report PDF.
- Data is scoped to the authenticated user's findings — no cross-user access.

**Organization context:**

| Capability                     | Required role                                           | Rationale                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View audit log                 | Any org member (`organizationMemberProcedure`)          | Read-only, consistent with viewing findings/stats.                                                                                                              |
| View compliance metrics        | Any org member (`organizationMemberProcedure`)          | Summary data only, same access level as finding stats.                                                                                                          |
| Download PDF compliance report | Owner or billing manager (`organizationOwnerProcedure`) | Report contains detailed vulnerability inventory and remediation evidence — restricted to match other write/export operations in the security agent org router. |
| Export audit log (CSV/JSON)    | Owner or billing manager (`organizationOwnerProcedure`) | Matches existing `securityAuditLog.export` permission level.                                                                                                    |

The PDF route handler enforces org access via `ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager'])` (see Phase 2). The existing org audit logs UI pattern also gates on `owner` role + enterprise plan client-side — the compliance report tab follows the same approach, hiding the download button for non-owner members and showing an upgrade prompt for non-enterprise plans if this restriction is desired.

### Date Range Validation

All endpoints that accept a reporting period enforce these constraints:

- `startDate` must be before `endDate`
- Maximum range: 366 days (accommodates leap years for annual reports)
- `endDate` must not be in the future (after current UTC time)
- Both dates validated as valid ISO 8601 UTC timestamps via zod

The date range picker in the UI enforces the same constraints client-side for immediate feedback. The server rejects invalid ranges with descriptive error messages.

### Performance Considerations

**No caching in v1.** The aggregation queries are scoped to a single owner and bounded by the 366-day max range, which keeps result sets manageable. The `getComplianceMetrics` endpoint (summary only) should return in <1s for typical datasets. PDF generation is heavier (full data load + rendering) but is an explicit user action, not a background poll.

If PDF generation latency becomes a problem (e.g., >10s for large orgs), a follow-on optimization would be to cache `ComplianceReportData` keyed by `(ownerId, startDate, endDate)` with a short TTL (e.g., 5 minutes), so that previewing metrics and then immediately downloading the PDF doesn't re-run all queries. This is deferred to v2 since the row caps (500 findings) already bound the worst case.

---

## Metric Definitions

Strict formulas for every metric in the report. All metrics are scoped to a single owner (user or organization) and a reporting period `[periodStart, periodEnd]` where both bounds are inclusive UTC timestamps.

### Canonical Populations

Every metric draws from one of these four populations. A finding may appear in more than one population.

| Population              | Definition                                                              | SQL Predicate (simplified)                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detected in period**  | Findings first seen during the period                                   | `first_detected_at >= periodStart AND first_detected_at <= periodEnd`                                                                                                                                                     |
| **Fixed in period**     | Findings whose fix was recorded during the period                       | `fixed_at IS NOT NULL AND fixed_at >= periodStart AND fixed_at <= periodEnd`                                                                                                                                              |
| **Dismissed in period** | Findings dismissed (manually or auto) during the period                 | Derived from `security_audit_log` where `action IN ('security.finding.dismissed', 'security.finding.auto_dismissed') AND created_at >= periodStart AND created_at <= periodEnd`, deduplicated by `finding_id` (see below) |
| **Open at period end**  | Findings that were open (not fixed, not dismissed) as of the period end | Point-in-time reconstruction from audit log (see below)                                                                                                                                                                   |

**Point-in-time state reconstruction for "Open at period end":** Querying `status = 'open'` reflects _current_ status, not status as of `periodEnd`. A finding open at Q1-end but fixed in Q2 would be missed. To produce stable, reproducible counts:

1. Start with all findings where `first_detected_at <= periodEnd`.
2. Exclude findings with `fixed_at IS NOT NULL AND fixed_at <= periodEnd` (fixed by period end).
3. Exclude findings dismissed by period end: join to `security_audit_log` where `action IN ('security.finding.dismissed', 'security.finding.auto_dismissed') AND created_at <= periodEnd`. Use the latest audit log event per `finding_id` — if the most recent status-change event before `periodEnd` is a dismissal, exclude it.

This means the "open at period end" population is derived entirely from immutable timestamp columns and the append-only audit log, so re-running the same report for the same period always produces the same counts.

**Dismissed-in-period deduplication:** A finding may be dismissed, reopened (via re-sync), and dismissed again within the same period. The dismissed-in-period query deduplicates by `finding_id`, keeping only the **latest** dismissal event per finding within the period. The Dismissal Log section shows the latest dismissal event's metadata (reason, actor, analysis). If the audit log references a `finding_id` that no longer exists in `security_findings` (e.g., the finding was deleted), that row is excluded from the population count and the Dismissal Log renders it with a "(finding deleted)" note using only audit log metadata.

**Invariant check:** `detected_in_period = fixed_in_period_from_detected + dismissed_in_period_from_detected + still_open_from_detected` — this holds only for the subset of "detected in period" findings. Findings fixed/dismissed in period may have been detected _before_ the period, so the populations are not a strict partition of a single set. This invariant is validated at runtime (see Phase 1 implementation notes).

The Executive Summary displays counts from each population independently and does not attempt to sum them into a single total.

### SLA Compliance Rate

```
sla_compliance_rate(severity) =
  COUNT(fixed_in_period WHERE severity = S AND fixed_at <= sla_due_at)
  /
  COUNT(fixed_in_period WHERE severity = S)
```

- **Denominator:** Only findings with `status = 'fixed'` and `fixed_at` within the period. Dismissed findings are excluded — they are tracked separately in the Exception & Dismissal Log.
- **Numerator:** Subset of denominator where `fixed_at <= sla_due_at`.
- **Edge case — null `sla_due_at`:** Excluded from both numerator and denominator. These findings predate SLA configuration and have no target to measure against. They appear in the Remediation Evidence table with "N/A" in the SLA columns.
- **Edge case — zero denominator:** Reported as "N/A" (not 0% or 100%).

**Overall SLA compliance rate:**

```
overall_sla_compliance_rate =
  COUNT(fixed_in_period WHERE fixed_at <= sla_due_at)
  /
  COUNT(fixed_in_period)
```

### Mean Time to Remediate (MTTR)

```
mttr(severity) =
  AVG(fixed_at - first_detected_at) for fixed_in_period WHERE severity = S
```

- Unit: calendar days (fractional, rounded to 1 decimal in display).
- **Denominator:** Same as SLA compliance denominator — only fixed findings in period.
- **Excluded:** Dismissed findings. Open findings.
- **Edge case — zero denominator:** Reported as "N/A".

### Median Time to Remediate

```
median_ttr(severity) =
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fixed_at - first_detected_at)
  for fixed_in_period WHERE severity = S
```

Same inclusion/exclusion rules as MTTR.

### Overdue Count

```
overdue_count =
  COUNT(open_at_period_end WHERE sla_due_at < periodEnd)
```

Findings that are still open and whose SLA due date has passed by the end of the reporting period.

### SLA Breach Details

For each finding in `fixed_in_period WHERE fixed_at > sla_due_at`:

```
days_overdue = (fixed_at - sla_due_at) in calendar days
```

### Historical SLA Policy

The `sla_due_at` stored on each finding is computed at sync time using the SLA config that was active when the finding was first detected (or last re-synced). This means the per-finding `sla_due_at` already reflects the historical SLA target — the report uses `sla_due_at` directly rather than re-computing from current config.

However, the SLA Policy section of the report must show which SLA targets were in effect during the period. This is reconstructed from `security_audit_log` entries with `action = 'security.config.updated'`:

1. Find the most recent `ConfigUpdated` event _before_ `periodStart` — its `after_state` is the SLA policy at period start.
2. Find all `ConfigUpdated` events _within_ the period — these are mid-period changes.
3. If no config change events exist, use the current config (it has been stable for the entire period or longer).

If SLA targets changed during the period, the report displays a table showing each effective SLA policy with its date range, and a note explaining that per-finding `sla_due_at` reflects the policy active at detection time.

---

## UI Design

Two new tabs added to `SecurityAgentPageClient`, making the tab bar:

**Findings | Analysis Jobs | Audit Log | Compliance Report | Config**

### Audit Log Tab

A searchable, filterable, paginated table of all security audit log entries. Follows the existing org audit logs UI pattern (`src/components/organizations/audit-logs/`).

- **Search bar** — Fuzzy text search across metadata
- **Expandable filter panel** — Action type multi-select, actor email, date range (start/end date+time)
- **Table columns** — Timestamp, Action (human-readable label), Actor, Resource Type, Resource ID, Summary
- **Row interactions** — Click-to-filter on action and actor columns; row click opens detail modal
- **Detail modal** — Full action metadata, before/after state diff, actor info, link to finding
- **Cursor-based pagination** — Prev/Next using `before`/`after` timestamps
- **Export button** — In card header, triggers `securityAuditLog.export`, downloads CSV or JSON

### Compliance Report Tab

A report configuration and preview card with PDF download.

- **Date range picker** — Start/end dates for the reporting period (default: last 90 days)
- **Preview section** — Inline metrics rendered from `getComplianceReportData`:
  - SLA compliance rate by severity (color-coded: green >95%, yellow >80%, red <80%)
  - MTTR by severity
  - Findings summary (new / fixed / dismissed / still open / overdue)
- **"Download PDF Report" button** — Calls the PDF generation route, downloads the file
- **Loading state** — Spinner while PDF renders server-side

---

## PDF Report Structure

The PDF is designed to be handed directly to a SOC2 auditor. It contains the following sections, each on one or more pages.

### Scope: v1 vs v2

**v1 (this plan):** Cover Page, Executive Summary, SLA Policy, SLA Compliance Metrics, Vulnerability Inventory, Remediation Evidence, Exception & Dismissal Log. These are the core sections auditors need — they prove the vulnerability management lifecycle is operational.

**v2 (follow-on):** Analysis Summary, Audit Trail Summary. These add depth but are not blocking for initial auditor handoff. The raw audit log export (already implemented) and the new Audit Log tab provide this evidence in v1.

### 1. Cover Page

- Report title: "SOC2 Vulnerability Management Compliance Report"
- Reporting period (start–end dates)
- Generation timestamp
- Organization/user name

### 2. Executive Summary

- Counts from each canonical population: detected in period, fixed in period, dismissed in period, open at period end
- Overall SLA compliance rate (formula: see Metric Definitions)
- Mean Time to Remediate (aggregate, formula: see Metric Definitions)
- Key risk indicators: overdue count, critical open count
- Auto-analysis and auto-dismiss coverage rates

### 3. SLA Policy

- Table of SLA targets per severity level in effect during the period
- If targets changed mid-period: table showing each effective policy with its date range, reconstructed from `ConfigUpdated` audit events (see Metric Definitions > Historical SLA Policy)
- If targets were stable: single table with the current config

### 4. SLA Compliance Metrics

- Per-severity table:
  - Number of findings fixed in period (denominator)
  - Number fixed within SLA (numerator)
  - Number that breached SLA
  - SLA compliance % (formula: see Metric Definitions)
  - Mean Time to Remediate in days (formula: see Metric Definitions)
  - Median Time to Remediate in days (formula: see Metric Definitions)
- Highlighted SLA breaches with details (finding ID, title, severity, days overdue)

### 5. Vulnerability Inventory

- Findings detected during period — grouped by severity, repository, ecosystem
- Findings fixed during period
- Findings still open at period end — with SLA status (within / breached)
- Overdue findings at period end (open + past SLA due date)

### 6. Remediation Evidence

- Table of findings fixed during period. Each row includes:
  - `finding_id` (for traceability)
  - Finding title, severity, CVE/GHSA ID
  - First detected date (`first_detected_at`)
  - SLA due date (`sla_due_at`)
  - Fixed date (`fixed_at`)
  - Days to remediate (`fixed_at - first_detected_at`)
  - Within SLA (yes/no: `fixed_at <= sla_due_at`)
  - `audit_log.id` of the status-change event
- Capped at 500 rows total (not per severity — 500 per severity could produce up to 2000 rows, making the PDF unwieldy). If exceeded, a note references the full JSON/CSV export.

### 7. Exception & Dismissal Log

- Manually dismissed findings: `finding_id`, `audit_log.id`, reason, actor, date, analysis evidence summary
- Auto-dismissed findings: `finding_id`, `audit_log.id`, triage/sandbox rationale, exploitability determination
- Distinction between human-approved and system-approved dismissals
- Capped at 500 rows. If exceeded, a note references the full JSON/CSV export.

### 8. Analysis Summary (v2)

- Triage results distribution (dismiss / analyze_codebase / manual_review)
- Sandbox analysis results (exploitable / not-exploitable / unknown)
- Analysis coverage: % of findings that received triage, % that received sandbox analysis
- Auto-dismiss effectiveness: % of auto-dismissed findings by tier

### 9. Audit Trail Summary (v2)

- Action distribution by type (bar/table showing counts per action)
- Timeline of significant events during the period
- Total audit events in period, earliest and latest timestamps
- Note referencing the full audit log export for detailed records

### 10. Footer (all pages)

- Page numbers
- Report generation timestamp and period in footer

---

## Implementation Phases

### Phase 1: Backend — Report Data Aggregation

New module that aggregates data from existing tables into the report structure. All queries implement the formulas defined in the Metric Definitions section.

**New file: `src/lib/security-agent/db/security-report.ts`**

Aggregation queries (all scoped to `[periodStart, periodEnd]` UTC + owner):

| Query                  | Source                                                                                              | Population                      | Output                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| SLA policy history     | `security_audit_log` where `action = 'security.config.updated'`                                     | Events before and during period | SLA targets per severity with effective date ranges                         |
| Detected in period     | `security_findings` where `first_detected_at BETWEEN start AND end`                                 | Detected in period              | Count + details by severity, repo, ecosystem                                |
| Fixed in period        | `security_findings` where `fixed_at IS NOT NULL AND fixed_at BETWEEN start AND end`                 | Fixed in period                 | Count + per-finding details with SLA compliance                             |
| SLA compliance metrics | Same as fixed in period, comparing `fixed_at` vs `sla_due_at`                                       | Fixed in period                 | Per-severity: fixed count, within-SLA count, breach count, MTTR, median TTR |
| Dismissed in period    | `security_audit_log` where `action IN (dismissed, auto_dismissed)` + join to `security_findings`    | Dismissed in period             | Details with reason, actor, analysis evidence                               |
| Open at period end     | `security_findings` + `security_audit_log` point-in-time reconstruction (see Canonical Populations) | Open at period end              | Count + overdue subset (`sla_due_at < periodEnd`)                           |
| Repo coverage          | `security_findings` `DISTINCT repo_full_name`                                                       | All findings in period          | Repos with findings vs configured repos                                     |

**Two tRPC procedures with different response sizes:**

**`securityAgent.getComplianceMetrics`** — lightweight, serves the inline preview in the Compliance Report tab:

```typescript
input: z.object({
  startDate: z.string().datetime(), // UTC
  endDate: z.string().datetime(), // UTC
});
```

Returns summary metrics only: per-severity SLA compliance rates, MTTR, median TTR, population counts (detected/fixed/dismissed/open/overdue), and SLA policy history. No individual finding rows. This is what the UI renders for the metric cards and is fast even for large datasets.

**`securityAgent.getComplianceReportData`** — full payload, serves the PDF generation route:

Same input schema. Returns a typed `ComplianceReportData` object containing all sections: summary metrics (same as above) plus individual finding rows for Remediation Evidence (capped at 500 per severity), Dismissal Log (capped at 500 total), and Vulnerability Inventory. This endpoint is only called by the PDF route handler server-side — it is never called directly from the browser.

Both procedures share the same underlying aggregation queries in `security-report.ts`, with a `includeDetails: boolean` flag controlling whether individual finding rows are fetched.

**Runtime invariant validation:** After computing all populations, `getComplianceReportData` validates the invariant: for findings detected in period, `detected = fixed_from_detected + dismissed_from_detected + still_open_from_detected`. If the invariant fails (e.g., due to an orphaned audit log entry or race condition during sync), the response includes a `warnings: string[]` field with a description of the mismatch. The PDF renders these warnings in a highlighted box at the top of the Executive Summary. This makes data issues visible to auditors rather than silently producing inconsistent numbers.

**New audit action:** Add `ComplianceReportGenerated = 'security.compliance_report.generated'` to `SecurityAuditLogAction` enum in `packages/db/src/schema-types.ts`. Log this action when a report is downloaded, recording `{ periodStart, periodEnd, format, rowCounts }` in metadata.

**Files to create:**

- `src/lib/security-agent/db/security-report.ts`

**Files to modify:**

- `packages/db/src/schema-types.ts` — Add `ComplianceReportGenerated` to enum
- `src/routers/security-agent-router.ts` — Add `getComplianceMetrics` and `getComplianceReportData` procedures
- `src/routers/organizations/organization-security-agent-router.ts` — Mirror both procedures for orgs

### Phase 2: Backend — PDF Generation Route

Server-side PDF rendering using `@react-pdf/renderer` and `@react-pdf/node`.

**Why `@react-pdf/renderer`:**

- JSX-based — consistent with the codebase's React patterns
- Server-side streaming via `renderToStream` — no headless browser needed
- Produces searchable, vector-text PDFs with proper tables and layouts
- Active maintenance and good Next.js compatibility

**New dependency:** `@react-pdf/renderer`, `@react-pdf/node`

**New route handler: `src/app/api/security-report/generate/route.ts`**

```
POST /api/security-report/generate
Body: { startDate, endDate, organizationId? }
Response: application/pdf stream
```

**Authentication and authorization** — follows the established route handler pattern (`getUserFromAuth` from `@/lib/user.server`):

1. Authenticate via `getUserFromAuth({ adminOnly: false })`. Returns 401 if no valid session or token.
2. Validate request body with zod (same schema as the tRPC procedure, plus date range validation — see Conventions > Date Range Validation).
3. If `organizationId` is provided: call `ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager'])` to verify the user has owner/billing_manager role (consistent with write operations in the org security agent router). Returns 403 if unauthorized.
4. If `organizationId` is absent: the report is scoped to the authenticated user's personal findings (no additional check needed, same as `baseProcedure` in the personal router).

**Request flow:**

- Calls the same aggregation logic from Phase 1
- Renders `@react-pdf/renderer` document components via `renderToStream`
- Returns the PDF as a streaming response
- Logs `ComplianceReportGenerated` audit event after successful PDF generation

**New files in `src/lib/security-agent/report/`:**

v1 files:

| File                             | Purpose                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `SecurityComplianceReport.tsx`   | Root `<Document>` component composing all pages                         |
| `CoverPage.tsx`                  | Title, period, generation date, owner name                              |
| `ExecutiveSummaryPage.tsx`       | Key metrics: population counts, SLA %, MTTR, risk indicators            |
| `SLAPolicyPage.tsx`              | SLA targets per severity with historical change tracking                |
| `SLACompliancePage.tsx`          | Per-severity compliance table, breach details                           |
| `VulnerabilityInventoryPage.tsx` | Detected/fixed/dismissed/open breakdown by severity, repo, ecosystem    |
| `RemediationEvidencePage.tsx`    | Table of fixed findings with SLA compliance + finding_id + audit_log.id |
| `DismissalLogPage.tsx`           | Dismissed findings with reason, actor, analysis evidence + IDs          |
| `report-styles.ts`               | Shared `@react-pdf/renderer` `StyleSheet` definitions                   |
| `report-utils.ts`                | Formatting helpers (dates, percentages, severity labels, colors)        |

v2 files (follow-on):

| File                        | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `AnalysisSummaryPage.tsx`   | Triage/sandbox distribution, analysis coverage |
| `AuditTrailSummaryPage.tsx` | Action distribution, timeline, event counts    |

### Phase 3: Audit Log Tab UI

New tab in `SecurityAgentPageClient` for browsing the security audit log.

**Reuse existing org audit log components.** The existing components in `src/components/organizations/audit-logs/` are already prop-driven: `AuditLogsTable` accepts `logs`, `availableActions`, `onFilterChange` props; `AuditLogDetailModal` accepts a generic log entry; `useAuditLogsFilters` is type-agnostic. Rather than duplicating 5 components (~700 lines), we generalize the existing ones and create a single new container:

**Generalize existing components (minor changes):**

| File                                                           | Change                                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/organizations/audit-logs/AuditLogsTable.tsx`   | Extract `formatActionForDisplay` into a prop (default: strip `organization.` prefix). Add `emptyMessage` prop.                   |
| `src/components/organizations/audit-logs/AuditLogsFilters.tsx` | Accept `availableActions` prop instead of hardcoding org-specific defaults (the prop already exists but defaults are hardcoded). |

These are small, backward-compatible changes — the org audit logs page continues to work as before by passing the existing defaults.

**New file:**

| File                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/security-agent/SecurityAuditLogCard.tsx` | Container card that owns data fetching via `trpc.securityAuditLog.list` / `trpc.organizations.securityAuditLog.list`, passes data to the generalized shared components. Provides `SecurityAuditLogAction` enum values as `availableActions`, a `security.`-prefix-stripping `formatAction`, and a security-specific empty message. Includes export button using existing `securityAuditLog.export` mutation — verify that the existing export endpoint accepts the current filter state (action type, date range, search) as parameters, and add filter passthrough if needed. |

This reduces Phase 3 from 5 new files (~700 lines) to 1 new file (~120-160 lines) plus 2 small modifications.

**Files to modify:**

- `src/components/organizations/audit-logs/AuditLogsTable.tsx` — Add `formatAction` and `emptyMessage` props
- `src/components/organizations/audit-logs/AuditLogsFilters.tsx` — Make default actions configurable via prop
- `src/components/security-agent/SecurityAgentPageClient.tsx` — Add `"audit-log"` tab value and render `SecurityAuditLogCard`
- `src/components/security-agent/index.ts` — Export new component

### Phase 4: Compliance Report Tab UI

New tab in `SecurityAgentPageClient` for previewing metrics and downloading the PDF report.

**New file: `src/components/security-agent/ComplianceReportCard.tsx`**

Contains:

- Date range picker (start/end date inputs, default: last 90 days)
- Inline preview section using data from `securityAgent.getComplianceMetrics` (lightweight — summary metrics only, no individual finding rows):
  - SLA compliance rate cards by severity (color-coded)
  - MTTR by severity
  - Findings summary (new / fixed / dismissed / open / overdue)
- "Download PDF Report" button
  - Calls `POST /api/security-report/generate` with selected date range
  - Shows loading state while PDF generates
  - Triggers browser download of the resulting PDF file
- Empty state when no findings exist in the selected period

**Files to modify:**

- `src/components/security-agent/SecurityAgentPageClient.tsx` — Add `"report"` tab value and render `ComplianceReportCard`
- `src/components/security-agent/index.ts` — Export new component

### Phase 5: Organization Variant

Components use the `organizationId?: string` prop pattern established in the codebase. This phase is integrated into Phases 1–4 (not deferred), because the org router requires separate tRPC procedures with `organizationMemberProcedure` / `organizationOwnerProcedure` middleware.

**Backend (integrated into Phases 1–2):**

- `organization-security-agent-router.ts` gets `getComplianceMetrics` (using `organizationMemberProcedure` — any member can view) and `getComplianceReportData` (using `organizationOwnerProcedure` — owners/billing managers only). These are separate procedure definitions, not conditional branches.
- The PDF route handler accepts `organizationId` in the request body and calls `ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager'])` before proceeding. See Phase 2 auth details.
- Aggregation queries in `security-report.ts` accept an `owner` parameter: `{ type: 'user', userId: string } | { type: 'organization', organizationId: string }` — this filters on the appropriate ownership column (`owned_by_user_id` vs `owned_by_organization_id`).

**Frontend (integrated into Phases 3–4):**

- `SecurityAuditLogCard` conditionally calls `trpc.organizations.securityAuditLog.list` vs `trpc.securityAuditLog.list` based on `organizationId` prop. Same pattern used by existing security agent components.
- `ComplianceReportCard` conditionally calls the org vs personal `getComplianceMetrics`. The PDF download button passes `organizationId` to the route handler.
- Both components hide restricted actions (PDF download, audit log export) for non-owner org members — check `currentRole` from the org context.

**No new files** — this is conditional logic within the components and routes from Phases 1–4, but it is real work that must be implemented alongside each phase, not deferred.

---

## Testing Strategy

Metric accuracy is critical for a compliance feature — incorrect numbers handed to an auditor undermine trust in the entire system. Each phase includes test requirements.

### Phase 1: Report Data Aggregation Tests

**File: `src/lib/security-agent/db/security-report.test.ts`**

Unit tests for every aggregation query and metric formula, using real database queries against seeded test data (no mocks). Each test seeds a known set of findings and audit log entries, then asserts exact metric values.

| Test area                           | Cases                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SLA compliance rate                 | All within SLA → 100%; mixed → exact ratio; zero fixed in period → "N/A"; null `sla_due_at` excluded from both numerator and denominator                                  |
| MTTR / median TTR                   | Known durations → exact averages/medians; single finding → MTTR equals its duration; zero denominator → "N/A"                                                             |
| Open at period end (point-in-time)  | Finding open at period end but fixed after → still counted as open; finding dismissed after period end → still counted as open; finding fixed before → excluded           |
| Dismissed in period (deduplication) | Finding dismissed, reopened, dismissed again in period → counted once (latest event); audit log entry with deleted finding → gracefully excluded                          |
| Invariant validation                | Seed data where invariant holds → no warning; seed data where invariant breaks (e.g., orphaned audit entry) → warning included in output                                  |
| SLA policy history                  | No config changes → current config used; config changed mid-period → multiple policy rows with correct date ranges; config changed before period → correct initial policy |
| Date boundary precision             | Findings at exact `periodStart` and `periodEnd` timestamps → correctly included; findings 1ms outside → excluded                                                          |
| Empty period                        | No findings in period → all sections return empty arrays/zero counts with "N/A" metrics, no errors                                                                        |

### Phase 2: PDF Generation Tests

**File: `src/lib/security-agent/report/security-compliance-report.test.ts`**

- **Smoke test:** Call `renderToStream` with a representative `ComplianceReportData` fixture and assert the output is a valid PDF (check for `%PDF` magic bytes and non-zero length).
- **Empty data test:** Render with all-empty sections and verify no crash — each section should produce its "no data" note.
- **Row cap test:** Supply >500 findings for a severity and verify the PDF renders without error and includes the "see full export" note.

### Phase 3–4: UI Component Tests

Standard component tests following existing patterns in the codebase. Key cases:

- Audit log table renders rows from mock tRPC response, click-to-filter updates filter state.
- Compliance report card shows loading state, renders metric cards from data, handles empty state.
- Date range picker enforces validation constraints (max 366 days, no future end dates).
- PDF download button shows spinner during generation, handles error responses.

### Integration Test

**File: `src/lib/security-agent/db/security-report-integration.test.ts`**

End-to-end test from seeded DB state → `getComplianceReportData` tRPC call → assert full response shape and metric values. This validates the entire pipeline from database through aggregation to typed output. Run via `pnpm vitest` with the standard test database.

---

## Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    Security Agent Page                        │
│                                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Findings │ │ Analysis │ │ Audit Log│ │  Report  │        │
│  │   Tab    │ │ Jobs Tab │ │   Tab    │ │   Tab    │        │
│  └──────────┘ └──────────┘ └────┬─────┘ └──┬────┬──┘        │
│                                  │          │    │            │
└──────────────────────────────────┼──────────┼────┼────────────┘
                                   │          │    │
                    ┌──────────────┘          │    │
                    ▼                         ▼    │
        ┌───────────────────┐   ┌─────────────────┴──────┐
        │ trpc.              │   │ trpc.securityAgent.     │
        │ securityAuditLog   │   │ getComplianceMetrics    │
        │ .list / .export    │   │ (summary metrics only)  │
        └───────────────────┘   └────────────┬────────────┘
                                              │
                                              ▼
                                 ┌──────────────────────┐
                                 │  Inline preview       │
                                 │  metric cards in UI   │
                                 └──────────────────────┘

  "Download PDF" button click:
        │
        ▼
  ┌──────────────────────────┐
  │ POST /api/security-      │
  │ report/generate           │
  │                           │
  │ 1. getUserFromAuth()      │
  │ 2. ensureOrganizationAc-  │
  │    cess() (if org)        │
  │ 3. getComplianceReport-   │    ┌────────────────────────┐
  │    Data (full payload     │───▶│ trpc.securityAgent.     │
  │    with finding rows)     │    │ getComplianceReportData │
  │ 4. renderToStream()       │    │ (server-side only)      │
  └────────────┬──────────────┘    └────────────────────────┘
               │
               ▼
    ┌──────────────────┐
    │ @react-pdf/node  │
    │ renderToStream   │
    │ → PDF download   │
    └──────────────────┘
```

---

## File Inventory

### New Files (v1)

| File                                                               | Phase | Lines (est.) |
| ------------------------------------------------------------------ | ----- | ------------ |
| `src/lib/security-agent/db/security-report.ts`                     | 1     | 250–350      |
| `src/lib/security-agent/db/security-report.test.ts`                | 1     | 300–400      |
| `src/lib/security-agent/db/security-report-integration.test.ts`    | 1     | 100–150      |
| `src/app/api/security-report/generate/route.ts`                    | 2     | 100–140      |
| `src/lib/security-agent/report/SecurityComplianceReport.tsx`       | 2     | 60–80        |
| `src/lib/security-agent/report/CoverPage.tsx`                      | 2     | 40–60        |
| `src/lib/security-agent/report/ExecutiveSummaryPage.tsx`           | 2     | 60–80        |
| `src/lib/security-agent/report/SLAPolicyPage.tsx`                  | 2     | 50–70        |
| `src/lib/security-agent/report/SLACompliancePage.tsx`              | 2     | 60–80        |
| `src/lib/security-agent/report/VulnerabilityInventoryPage.tsx`     | 2     | 60–80        |
| `src/lib/security-agent/report/RemediationEvidencePage.tsx`        | 2     | 70–90        |
| `src/lib/security-agent/report/DismissalLogPage.tsx`               | 2     | 60–80        |
| `src/lib/security-agent/report/report-styles.ts`                   | 2     | 60–80        |
| `src/lib/security-agent/report/report-utils.ts`                    | 2     | 40–60        |
| `src/lib/security-agent/report/security-compliance-report.test.ts` | 2     | 60–80        |
| `src/components/security-agent/SecurityAuditLogCard.tsx`           | 3     | 120–160      |
| `src/components/security-agent/ComplianceReportCard.tsx`           | 4     | 200–260      |

**Total new files (v1):** 17
**Total estimated new lines:** 1,690–2,340 (includes tests)

### New Files (v2 — follow-on)

| File                                                      | Phase | Lines (est.) |
| --------------------------------------------------------- | ----- | ------------ |
| `src/lib/security-agent/report/AnalysisSummaryPage.tsx`   | v2    | 50–70        |
| `src/lib/security-agent/report/AuditTrailSummaryPage.tsx` | v2    | 50–70        |

### Modified Files

| File                                                              | Phase | Change                                                                          |
| ----------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| `package.json`                                                    | 2     | Add `@react-pdf/renderer`, `@react-pdf/node`                                    |
| `packages/db/src/schema-types.ts`                                 | 1     | Add `ComplianceReportGenerated` to enum                                         |
| `src/routers/security-agent-router.ts`                            | 1     | Add `getComplianceMetrics` and `getComplianceReportData` procedures             |
| `src/routers/organizations/organization-security-agent-router.ts` | 1     | Mirror both procedures for orgs                                                 |
| `src/components/organizations/audit-logs/AuditLogsTable.tsx`      | 3     | Add `formatAction` and `emptyMessage` props (backward-compatible with defaults) |
| `src/components/organizations/audit-logs/AuditLogsFilters.tsx`    | 3     | Make default actions configurable via prop                                      |
| `src/components/security-agent/SecurityAgentPageClient.tsx`       | 3, 4  | Add `"audit-log"` and `"report"` tabs                                           |
| `src/components/security-agent/index.ts`                          | 3, 4  | Export new components                                                           |

---

## Key Existing Code References

| Concept                                  | File                                                                  | Lines          |
| ---------------------------------------- | --------------------------------------------------------------------- | -------------- |
| Security findings schema                 | `packages/db/src/schema.ts`                                           | 2389–2500      |
| Security audit log schema                | `packages/db/src/schema.ts`                                           | 2663–2699      |
| Audit log action enum                    | `packages/db/src/schema-types.ts`                                     | 99–113         |
| SLA config + defaults                    | `src/lib/security-agent/core/types.ts`                                | 51–111         |
| SLA constants                            | `src/lib/security-agent/core/constants.ts`                            | 15–31          |
| Audit log service                        | `src/lib/security-agent/services/audit-log-service.ts`                | —              |
| Audit log tRPC router (personal)         | `src/routers/security-audit-log-router.ts`                            | 1–243          |
| Audit log tRPC router (org)              | `src/routers/organizations/organization-security-audit-log-router.ts` | —              |
| Finding stats query                      | `src/lib/security-agent/db/security-findings.ts`                      | 438–522        |
| Org audit logs UI (reused + generalized) | `src/components/organizations/audit-logs/`                            | —              |
| Route handler auth utility               | `src/lib/user.server.ts` (`getUserFromAuth`)                          | 674–734        |
| Org access control utility               | `src/routers/organizations/utils.ts` (`ensureOrganizationAccess`)     | 15+            |
| Security Agent page client               | `src/components/security-agent/SecurityAgentPageClient.tsx`           | 818–834 (tabs) |

---

## Dependency Addition

```
@react-pdf/renderer  — React component model for PDF document definition
@react-pdf/node      — Server-side renderToStream for Node.js / Next.js routes
```

No other new dependencies required. All UI components use existing packages: `@tanstack/react-query` (via tRPC-react), `date-fns`, `lucide-react`, `zod`, and the project's UI component library (`src/components/ui/`).

---

## Open Questions

1. **Report branding** — Should the PDF include a Kilo logo on the cover page? If so, the logo asset needs to be bundled for `@react-pdf/renderer` (it supports PNG/JPG images).
2. **Scheduled reports** — Should we support periodic (e.g., quarterly) automatic report generation and email delivery? This is out of scope for v1 but is a natural follow-on alongside the v2 report sections.
