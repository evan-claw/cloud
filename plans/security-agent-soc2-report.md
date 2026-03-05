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

---

## Metric Definitions

Strict formulas for every metric in the report. All metrics are scoped to a single owner (user or organization) and a reporting period `[periodStart, periodEnd]` where both bounds are inclusive UTC timestamps.

### Canonical Populations

Every metric draws from one of these four populations. A finding may appear in more than one population.

| Population              | Definition                                                              | SQL Predicate (simplified)                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detected in period**  | Findings first seen during the period                                   | `first_detected_at >= periodStart AND first_detected_at <= periodEnd`                                                                                                           |
| **Fixed in period**     | Findings whose fix was recorded during the period                       | `fixed_at IS NOT NULL AND fixed_at >= periodStart AND fixed_at <= periodEnd`                                                                                                    |
| **Dismissed in period** | Findings dismissed (manually or auto) during the period                 | Derived from `security_audit_log` where `action IN ('security.finding.dismissed', 'security.finding.auto_dismissed') AND created_at >= periodStart AND created_at <= periodEnd` |
| **Open at period end**  | Findings that were open (not fixed, not dismissed) as of the period end | `status = 'open' AND first_detected_at <= periodEnd`                                                                                                                            |

**Invariant check:** `detected_in_period = fixed_in_period_from_detected + dismissed_in_period_from_detected + still_open_from_detected` — this holds only for the subset of "detected in period" findings. Findings fixed/dismissed in period may have been detected _before_ the period, so the populations are not a strict partition of a single set.

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
- Capped at 500 rows per severity. If exceeded, a note references the full JSON/CSV export.

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

| Query                  | Source                                                                                           | Population                      | Output                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| SLA policy history     | `security_audit_log` where `action = 'security.config.updated'`                                  | Events before and during period | SLA targets per severity with effective date ranges                         |
| Detected in period     | `security_findings` where `first_detected_at BETWEEN start AND end`                              | Detected in period              | Count + details by severity, repo, ecosystem                                |
| Fixed in period        | `security_findings` where `fixed_at IS NOT NULL AND fixed_at BETWEEN start AND end`              | Fixed in period                 | Count + per-finding details with SLA compliance                             |
| SLA compliance metrics | Same as fixed in period, comparing `fixed_at` vs `sla_due_at`                                    | Fixed in period                 | Per-severity: fixed count, within-SLA count, breach count, MTTR, median TTR |
| Dismissed in period    | `security_audit_log` where `action IN (dismissed, auto_dismissed)` + join to `security_findings` | Dismissed in period             | Details with reason, actor, analysis evidence                               |
| Open at period end     | `security_findings` where `status = 'open' AND first_detected_at <= end`                         | Open at period end              | Count + overdue subset (`sla_due_at < periodEnd`)                           |
| Repo coverage          | `security_findings` `DISTINCT repo_full_name`                                                    | All findings in period          | Repos with findings vs configured repos                                     |

**New tRPC procedure: `securityAgent.getComplianceReportData`**

```typescript
input: z.object({
  startDate: z.string().datetime(), // UTC
  endDate: z.string().datetime(), // UTC
});
```

Returns a typed `ComplianceReportData` object containing all sections above. This endpoint serves both the inline preview (Compliance Report tab) and the PDF generation route.

**New audit action:** Add `ComplianceReportGenerated = 'security.compliance_report.generated'` to `SecurityAuditLogAction` enum in `packages/db/src/schema-types.ts`. Log this action when a report is downloaded, recording `{ periodStart, periodEnd, format, rowCounts }` in metadata.

**Files to create:**

- `src/lib/security-agent/db/security-report.ts`

**Files to modify:**

- `packages/db/src/schema-types.ts` — Add `ComplianceReportGenerated` to enum
- `src/routers/security-agent-router.ts` — Add `getComplianceReportData` procedure
- `src/routers/organizations/organization-security-agent-router.ts` — Mirror for orgs

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

- Authenticates the user via session
- Calls the same aggregation logic from Phase 1
- Renders `@react-pdf/renderer` document components via `renderToStream`
- Returns the PDF as a streaming response

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

**New files in `src/components/security-agent/`:**

| File                              | Purpose                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SecurityAuditLogCard.tsx`        | Container card, owns data fetching via `trpc.securityAuditLog.list` / `trpc.organizations.securityAuditLog.list` |
| `SecurityAuditLogFilters.tsx`     | Filter panel: text search, action type multi-select, actor email, date range, clear button                       |
| `SecurityAuditLogTable.tsx`       | Table with columns: Timestamp, Action, Actor, Resource, Summary. Click-to-filter, row click opens modal          |
| `SecurityAuditLogDetailModal.tsx` | Detail view: full metadata, before/after state, actor info, resource link                                        |
| `SecurityAuditLogPagination.tsx`  | Cursor-based prev/next navigation using `before`/`after` timestamps                                              |

**Adapted from:** `src/components/organizations/audit-logs/` — same patterns (filters, table, modal, pagination) but wired to the security-specific tRPC endpoints and using `SecurityAuditLogAction` enum values.

**Export functionality:** Export button in the card header uses the existing `securityAuditLog.export` mutation. Triggers a client-side download of CSV or JSON.

**Files to modify:**

- `src/components/security-agent/SecurityAgentPageClient.tsx` — Add `"audit-log"` tab value and render `SecurityAuditLogCard`
- `src/components/security-agent/index.ts` — Export new components

### Phase 4: Compliance Report Tab UI

New tab in `SecurityAgentPageClient` for previewing metrics and downloading the PDF report.

**New file: `src/components/security-agent/ComplianceReportCard.tsx`**

Contains:

- Date range picker (start/end date inputs, default: last 90 days)
- Inline preview section using data from `securityAgent.getComplianceReportData`:
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

All components already follow the `organizationId?: string` prop pattern established in the codebase. The work is:

- Audit Log components route tRPC calls through `trpc.organizations.securityAuditLog.*` when `organizationId` is present
- Report data endpoint mirrors to `trpc.organizations.securityAgent.getComplianceReportData`
- PDF generation route accepts `organizationId` in the request body and validates org membership
- No new files — this is conditional logic within the components and routes from Phases 1–4

---

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                  Security Agent Page                     │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Findings │ │ Analysis │ │ Audit Log│ │  Report  │   │
│  │   Tab    │ │ Jobs Tab │ │   Tab    │ │   Tab    │   │
│  └──────────┘ └──────────┘ └────┬─────┘ └────┬─────┘   │
│                                  │            │          │
└──────────────────────────────────┼────────────┼──────────┘
                                   │            │
                    ┌──────────────┘            │
                    ▼                           ▼
        ┌───────────────────┐      ┌────────────────────┐
        │ trpc.              │      │ trpc.               │
        │ securityAuditLog   │      │ securityAgent.      │
        │ .list / .export    │      │ getComplianceReport │
        │                    │      │ Data                │
        └───────────────────┘      └─────────┬──────────┘
                                              │
                           ┌──────────────────┤
                           ▼                  ▼
                ┌──────────────────┐  ┌──────────────────┐
                │  Inline preview  │  │ POST /api/        │
                │  metrics in UI   │  │ security-report/  │
                │                  │  │ generate          │
                └──────────────────┘  └────────┬─────────┘
                                               │
                                               ▼
                                    ┌──────────────────┐
                                    │ @react-pdf/node  │
                                    │ renderToStream   │
                                    │                  │
                                    │ → PDF download   │
                                    └──────────────────┘
```

---

## File Inventory

### New Files (v1)

| File                                                            | Phase | Lines (est.) |
| --------------------------------------------------------------- | ----- | ------------ |
| `src/lib/security-agent/db/security-report.ts`                  | 1     | 250–350      |
| `src/app/api/security-report/generate/route.ts`                 | 2     | 80–120       |
| `src/lib/security-agent/report/SecurityComplianceReport.tsx`    | 2     | 60–80        |
| `src/lib/security-agent/report/CoverPage.tsx`                   | 2     | 40–60        |
| `src/lib/security-agent/report/ExecutiveSummaryPage.tsx`        | 2     | 60–80        |
| `src/lib/security-agent/report/SLAPolicyPage.tsx`               | 2     | 50–70        |
| `src/lib/security-agent/report/SLACompliancePage.tsx`           | 2     | 60–80        |
| `src/lib/security-agent/report/VulnerabilityInventoryPage.tsx`  | 2     | 60–80        |
| `src/lib/security-agent/report/RemediationEvidencePage.tsx`     | 2     | 70–90        |
| `src/lib/security-agent/report/DismissalLogPage.tsx`            | 2     | 60–80        |
| `src/lib/security-agent/report/report-styles.ts`                | 2     | 60–80        |
| `src/lib/security-agent/report/report-utils.ts`                 | 2     | 40–60        |
| `src/components/security-agent/SecurityAuditLogCard.tsx`        | 3     | 120–160      |
| `src/components/security-agent/SecurityAuditLogFilters.tsx`     | 3     | 150–200      |
| `src/components/security-agent/SecurityAuditLogTable.tsx`       | 3     | 150–200      |
| `src/components/security-agent/SecurityAuditLogDetailModal.tsx` | 3     | 100–140      |
| `src/components/security-agent/SecurityAuditLogPagination.tsx`  | 3     | 40–60        |
| `src/components/security-agent/ComplianceReportCard.tsx`        | 4     | 200–260      |

**Total new files (v1):** 18
**Total estimated new lines:** 1,650–2,250

### New Files (v2 — follow-on)

| File                                                      | Phase | Lines (est.) |
| --------------------------------------------------------- | ----- | ------------ |
| `src/lib/security-agent/report/AnalysisSummaryPage.tsx`   | v2    | 50–70        |
| `src/lib/security-agent/report/AuditTrailSummaryPage.tsx` | v2    | 50–70        |

### Modified Files

| File                                                              | Phase | Change                                       |
| ----------------------------------------------------------------- | ----- | -------------------------------------------- |
| `package.json`                                                    | 2     | Add `@react-pdf/renderer`, `@react-pdf/node` |
| `packages/db/src/schema-types.ts`                                 | 1     | Add `ComplianceReportGenerated` to enum      |
| `src/routers/security-agent-router.ts`                            | 1     | Add `getComplianceReportData` procedure      |
| `src/routers/organizations/organization-security-agent-router.ts` | 1     | Mirror `getComplianceReportData` for orgs    |
| `src/components/security-agent/SecurityAgentPageClient.tsx`       | 3, 4  | Add `"audit-log"` and `"report"` tabs        |
| `src/components/security-agent/index.ts`                          | 3, 4  | Export new components                        |

---

## Key Existing Code References

| Concept                               | File                                                                  | Lines          |
| ------------------------------------- | --------------------------------------------------------------------- | -------------- |
| Security findings schema              | `packages/db/src/schema.ts`                                           | 2389–2500      |
| Security audit log schema             | `packages/db/src/schema.ts`                                           | 2663–2699      |
| Audit log action enum                 | `packages/db/src/schema-types.ts`                                     | 99–113         |
| SLA config + defaults                 | `src/lib/security-agent/core/types.ts`                                | 51–111         |
| SLA constants                         | `src/lib/security-agent/core/constants.ts`                            | 15–31          |
| Audit log service                     | `src/lib/security-agent/services/audit-log-service.ts`                | —              |
| Audit log tRPC router (personal)      | `src/routers/security-audit-log-router.ts`                            | 1–243          |
| Audit log tRPC router (org)           | `src/routers/organizations/organization-security-audit-log-router.ts` | —              |
| Finding stats query                   | `src/lib/security-agent/db/security-findings.ts`                      | 438–522        |
| Org audit logs UI (pattern to follow) | `src/components/organizations/audit-logs/`                            | —              |
| Security Agent page client            | `src/components/security-agent/SecurityAgentPageClient.tsx`           | 818–834 (tabs) |

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
