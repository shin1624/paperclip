// PMSA-19 / PMSA-11 §4: quota incident watcher.
//
// Runs every five minutes per company and decides whether the board needs to
// be paged about Opus quota pressure. Three independent trigger conditions:
//
//   1. Company-wide volume:    >= 5 `claude_quota_exhausted` runs in last 30m.
//   2. Per-agent streak:        same agent had 3 consecutive
//                              `claude_quota_exhausted` runs in last 5m
//                              (no other terminal errorCode and no clean run
//                              in between).
//   3. Opus weekly saturation:  Anthropic `Current week (Opus only)` quota
//                              window reports >= 90% utilization.
//
// When any trigger fires we open a single `request_board_attention` approval
// with `subtype=quota_exhaustion`. Dedup: if the company already has an open
// (pending / revision_requested) approval of the same subtype, we skip
// creating another so we do not spam the board on every tick.
//
// The approval payload is the metrics snapshot the costs dashboard exposes,
// plus a list of recommended remediations (Sonnet fallback, raise budget,
// flip Bedrock supervisor) so the board can act without re-deriving context.

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import {
  quotaIncidentsService,
  type QuotaIncidentsResult,
} from "./quota-incidents.js";
import { fetchAllQuotaWindows } from "./quota-windows.js";
import {
  buildOpusSlotKey,
  getInflightCount,
  getWaiterCount,
  resolveOpusConcurrencyCapacity,
} from "./provider-semaphore.js";

// Knobs are exported so tests and the costs route can describe the same
// thresholds the watcher applies. They match the [PMSA-11] §4 design.
export const QUOTA_WATCHER_INTERVAL_MS = 5 * 60 * 1000;
export const QUOTA_WATCHER_COMPANY_INCIDENT_WINDOW_MINUTES = 30;
export const QUOTA_WATCHER_AGENT_STREAK_WINDOW_MINUTES = 5;
export const QUOTA_WATCHER_COMPANY_INCIDENT_THRESHOLD = 5;
export const QUOTA_WATCHER_AGENT_STREAK_THRESHOLD = 3;
export const QUOTA_WATCHER_OPUS_UTILIZATION_THRESHOLD_PERCENT = 90;

export const QUOTA_INCIDENT_APPROVAL_TYPE = "request_board_attention";
export const QUOTA_INCIDENT_APPROVAL_SUBTYPE = "quota_exhaustion";

// PMSA-21 / PMSA-11 §3.5 Phase 3: event-driven consumer of the
// `quotaRetryExhausted` lifecycle events that PMSA-18's bounded retry path
// emits onto `heartbeat_run_events.payload`. Distinct from the metric-based
// PMSA-19 sweep above: this path acts on the *individual* exhausted run and
// either auto-resumes the executing issue (quota recovered) or pages the
// board with a per-(issue, agent) approval so silent stalls surface.
export const QUOTA_EVENT_LOOKBACK_MINUTES = 30;
export const QUOTA_EVENT_DEDUP_WINDOW_MINUTES = 30;
// Anthropic's Opus weekly window flips back below 90% as quota rolls over;
// reuse the same threshold the metric watcher uses to avoid two definitions
// of "quota recovered".
export const QUOTA_EVENT_OPUS_RECOVERY_THRESHOLD_PERCENT =
  QUOTA_WATCHER_OPUS_UTILIZATION_THRESHOLD_PERCENT;
export const QUOTA_EVENT_APPROVAL_TYPE = "request_board_attention";
// Different subtype than the metric watcher so the per-issue approval is not
// deduped against the company-wide one (and vice versa).
export const QUOTA_EVENT_APPROVAL_SUBTYPE = "quota_retry_exhausted";

const QUOTA_STREAK_ERROR_CODE = "claude_quota_exhausted";
// Anthropic OAuth `seven_day_opus` is rendered with this label by the claude_local
// adapter (see packages/adapters/claude-local/src/server/quota.ts). We match
// case-insensitively + with whitespace collapse so the watcher keeps working
// if the label gets minor wording tweaks.
const OPUS_WEEKLY_QUOTA_LABEL = "current week (opus only)";
const ANTHROPIC_PROVIDER_SLUG = "anthropic";

export type QuotaWatcherTriggerReason =
  | "company_quota_volume"
  | "agent_quota_streak"
  | "opus_weekly_saturation";

export interface QuotaWatcherAgentStreak {
  agentId: string;
  agentName: string | null;
  streakCount: number;
  windowMinutes: number;
  firstAt: string;
  lastAt: string;
}

export interface QuotaWatcherOpusSaturation {
  provider: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface QuotaWatcherThrottleSnapshot {
  provider: "anthropic";
  modelFamily: "opus";
  capacity: number;
  inflight: number;
  waiters: number;
}

export interface QuotaWatcherMetricsSnapshot {
  generatedAt: string;
  incidents: {
    windowMinutes: number;
    total: number;
    totalByCode: QuotaIncidentsResult["totalByCode"];
    oldestAt: string | null;
    newestAt: string | null;
    byAgent: Array<{
      agentId: string;
      agentName: string | null;
      count: number;
      countByCode: QuotaIncidentsResult["totalByCode"];
      lastAt: string | null;
    }>;
  };
  agentStreaks: QuotaWatcherAgentStreak[];
  opusSaturation: QuotaWatcherOpusSaturation | null;
  throttle: QuotaWatcherThrottleSnapshot;
}

export interface QuotaWatcherRecommendedAction {
  label: string;
  href: string;
  description: string;
}

export interface QuotaWatcherTickResult {
  companyId: string;
  triggers: QuotaWatcherTriggerReason[];
  approvalId: string | null;
  approvalCreated: boolean;
  skippedReason:
    | "no_triggers"
    | "dedup_existing_approval"
    | "company_missing"
    | null;
  metricsSnapshot: QuotaWatcherMetricsSnapshot;
}

export interface QuotaWatcherTickAllResult {
  scanned: number;
  triggered: number;
  approvalsCreated: number;
  results: QuotaWatcherTickResult[];
}

export interface QuotaWatcherDeps {
  quotaIncidents?: ReturnType<typeof quotaIncidentsService>;
  fetchProviderQuotaWindows?: () => Promise<ProviderQuotaResult[]>;
  semaphore?: {
    getInflightCount: (companyId: string) => number;
    getWaiterCount: (companyId: string) => number;
  };
  now?: () => Date;
  // PMSA-21: event-driven consumer wiring. Both injectables are optional so
  // pure-function consumers (and the existing PMSA-19 path) keep working with
  // no wiring. When unset, the consumer no-ops on its mutating branches and
  // only reports what it would have done.
  issueResume?: (
    issueId: string,
    args: { agentId: string | null; nextStatus: "todo" },
  ) => Promise<{ status: string } | null>;
  enqueueWakeup?: (
    agentId: string,
    opts: {
      reason: string;
      source?: "timer" | "assignment" | "on_demand" | "automation";
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown> | unknown;
}

// PMSA-21: shape we extract from a `heartbeat_run_events.payload` entry that
// PMSA-18 stamps when its bounded quota retry budget is exhausted. Keep this
// in sync with `markQuotaExhaustedIssueBlocked` in services/heartbeat.ts.
export interface QuotaRetryExhaustedPayload {
  quotaRetryExhausted: true;
  errorCode: "claude_quota_exhausted" | "claude_rate_limited" | string;
  attempts: number;
  maxAttempts: number;
  issueId: string;
  // PMSA-18 records the post-action issue status: "blocked" when the watcher
  // moved it, or the original status when it was already blocked / cancelled.
  issueStatus: string;
  // Only present on the success branch. The "already blocked" branch omits it.
  agentId?: string;
}

export type QuotaEventOutcome =
  | "issue_resumed"
  | "approval_created"
  | "approval_skipped_existing"
  | "issue_already_unblocked"
  | "issue_missing"
  | "agent_unknown"
  | "deduped_in_tick"
  | "skipped_invalid_payload";

export interface QuotaEventResult {
  eventId: number;
  runId: string;
  agentId: string | null;
  agentName: string | null;
  issueId: string | null;
  errorCode: string | null;
  attempts: number | null;
  outcome: QuotaEventOutcome;
  approvalId: string | null;
  resumedAt: string | null;
}

export interface QuotaEventConsumeResult {
  companyId: string;
  scannedEvents: number;
  uniquePairs: number;
  resumedIssues: number;
  approvalsCreated: number;
  approvalsDeduped: number;
  invalidPayloads: number;
  quotaRecovered: boolean;
  results: QuotaEventResult[];
}

interface AgentStreakRow {
  agentId: string;
  agentName: string | null;
  errorCode: string | null;
  finishedAt: Date | null;
}

function defaultSemaphoreShim() {
  return {
    getInflightCount: (companyId: string) =>
      getInflightCount(buildOpusSlotKey(companyId)),
    getWaiterCount: (companyId: string) =>
      getWaiterCount(buildOpusSlotKey(companyId)),
  };
}

function normalizeQuotaLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * PMSA-21: parse a `heartbeat_run_events.payload` JSON blob into the strict
 * shape PMSA-18 emits. Returns null if the payload is missing required fields
 * or the marker flag is not set, so the consumer can skip stale / unrelated
 * events without throwing.
 *
 * Exposed for tests so the parser invariants can be pinned without an
 * embedded Postgres harness.
 */
export function parseQuotaRetryExhaustedPayload(
  payload: unknown,
): QuotaRetryExhaustedPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.quotaRetryExhausted !== true) return null;
  const errorCode = typeof p.errorCode === "string" ? p.errorCode : null;
  const issueId = typeof p.issueId === "string" ? p.issueId : null;
  const issueStatus = typeof p.issueStatus === "string" ? p.issueStatus : null;
  const attempts = typeof p.attempts === "number" ? p.attempts : null;
  const maxAttempts = typeof p.maxAttempts === "number" ? p.maxAttempts : null;
  if (
    !errorCode ||
    !issueId ||
    !issueStatus ||
    attempts == null ||
    maxAttempts == null
  ) {
    return null;
  }
  const agentId = typeof p.agentId === "string" ? p.agentId : undefined;
  return {
    quotaRetryExhausted: true,
    errorCode,
    issueId,
    issueStatus,
    attempts,
    maxAttempts,
    agentId,
  };
}

/**
 * PMSA-21: decide whether the Anthropic Opus weekly quota has recovered
 * enough to safely auto-resume blocked issues. We treat the quota as
 * recovered when:
 *
 *   - we have no Opus saturation reading at all (no provider, no window, or
 *     percent unknown — defaulting to "unblock" matches the issue spec which
 *     asks the watcher to clear the way as soon as evidence of pressure is
 *     gone), OR
 *   - utilization is strictly below the saturation threshold the metric
 *     watcher uses (90%), OR
 *   - the window's `resetsAt` has passed (Anthropic rolls the bucket).
 *
 * Exposed for tests. The metric and event watchers share this definition so
 * we don't drift on what "recovered" means.
 */
export function isOpusQuotaRecovered(
  saturation: QuotaWatcherOpusSaturation | null,
  now: Date,
): boolean {
  if (!saturation) return true;
  if (saturation.usedPercent == null) return true;
  if (saturation.usedPercent < QUOTA_EVENT_OPUS_RECOVERY_THRESHOLD_PERCENT) {
    return true;
  }
  if (saturation.resetsAt) {
    const resets = new Date(saturation.resetsAt);
    if (!Number.isNaN(resets.getTime()) && resets <= now) return true;
  }
  return false;
}

/**
 * Pull the Opus weekly saturation window out of the aggregated provider quota
 * results. Returns null if the Anthropic provider failed, did not report the
 * window, or the percent is unknown.
 *
 * Exposed so the costs route can render the same value the watcher uses for
 * threshold decisions.
 */
export function findOpusWeeklySaturation(
  results: ProviderQuotaResult[] | null | undefined,
): QuotaWatcherOpusSaturation | null {
  if (!results) return null;
  const anthropic = results.find(
    (r) => r.provider === ANTHROPIC_PROVIDER_SLUG && r.ok,
  );
  if (!anthropic) return null;
  const window = anthropic.windows.find(
    (w) => normalizeQuotaLabel(w.label) === OPUS_WEEKLY_QUOTA_LABEL,
  );
  if (!window || window.usedPercent == null) return null;
  return {
    provider: anthropic.provider,
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
  };
}

/**
 * Scan recently-finished heartbeat runs in the agent-streak window and
 * compute, per agent, how many of the most recent runs (in time order) ended
 * with `claude_quota_exhausted` before any other terminal outcome.
 *
 * Exposed for tests; the watcher consumes only the streaks that meet the
 * threshold but the caller can choose to surface partial streaks separately.
 */
export function computeQuotaStreaksFromRows(
  rows: AgentStreakRow[],
  windowMinutes: number,
): QuotaWatcherAgentStreak[] {
  const grouped = new Map<string, AgentStreakRow[]>();
  for (const row of rows) {
    if (!row.finishedAt) continue;
    const list = grouped.get(row.agentId) ?? [];
    list.push(row);
    grouped.set(row.agentId, list);
  }

  const streaks: QuotaWatcherAgentStreak[] = [];
  for (const [agentId, list] of grouped) {
    list.sort(
      (a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0),
    );

    let streakCount = 0;
    let firstAt: Date | null = null;
    let lastAt: Date | null = null;
    let agentName: string | null = null;

    for (const row of list) {
      if (row.errorCode !== QUOTA_STREAK_ERROR_CODE) break;
      streakCount += 1;
      if (row.agentName && !agentName) agentName = row.agentName;
      if (!lastAt && row.finishedAt) lastAt = row.finishedAt;
      if (row.finishedAt) firstAt = row.finishedAt;
    }

    if (streakCount > 0 && firstAt && lastAt) {
      streaks.push({
        agentId,
        agentName: agentName,
        streakCount,
        windowMinutes,
        firstAt: firstAt.toISOString(),
        lastAt: lastAt.toISOString(),
      });
    }
  }

  streaks.sort((a, b) => b.streakCount - a.streakCount);
  return streaks;
}

function buildRecommendedActions(
  companyId: string,
): QuotaWatcherRecommendedAction[] {
  // Best-effort UI links. We do not have the company prefix at this layer, so
  // we render id-form deep links and let the dashboard resolve them.
  return [
    {
      label: "Review quota incidents",
      href: `/companies/${companyId}/costs/quota-incidents`,
      description:
        "Open the quota incidents breakdown to see which agents are stalling on 401/429.",
    },
    {
      label: "Adjust Opus concurrency",
      href: `/companies/${companyId}#metadata.opusConcurrencyMax`,
      description:
        "Lower the company-wide Opus semaphore to reduce simultaneous quota pressure.",
    },
    {
      label: "Enable opt-in Sonnet fallback (CEO)",
      href: `/companies/${companyId}/agents`,
      description:
        "Authorize Sonnet fallback on a per-agent basis when Opus quota is depleted (PMSA-20).",
    },
  ];
}

function buildSnapshot(
  incidents: QuotaIncidentsResult,
  agentStreaks: QuotaWatcherAgentStreak[],
  opusSaturation: QuotaWatcherOpusSaturation | null,
  throttle: QuotaWatcherThrottleSnapshot,
  generatedAt: Date,
): QuotaWatcherMetricsSnapshot {
  return {
    generatedAt: generatedAt.toISOString(),
    incidents: {
      windowMinutes: incidents.windowMinutes,
      total: incidents.total,
      totalByCode: incidents.totalByCode,
      oldestAt: incidents.oldestAt ? incidents.oldestAt.toISOString() : null,
      newestAt: incidents.newestAt ? incidents.newestAt.toISOString() : null,
      byAgent: incidents.byAgent.map((row) => ({
        agentId: row.agentId,
        agentName: row.agentName,
        count: row.count,
        countByCode: row.countByCode,
        lastAt: row.lastAt ? row.lastAt.toISOString() : null,
      })),
    },
    agentStreaks,
    opusSaturation,
    throttle,
  };
}

function buildApprovalSummary(
  companyName: string,
  triggers: QuotaWatcherTriggerReason[],
  snapshot: QuotaWatcherMetricsSnapshot,
): string {
  const parts: string[] = [];
  if (triggers.includes("company_quota_volume")) {
    parts.push(
      `${snapshot.incidents.total} quota incident(s) in the last ${snapshot.incidents.windowMinutes}m for ${companyName}`,
    );
  }
  if (triggers.includes("agent_quota_streak")) {
    const top = snapshot.agentStreaks[0];
    if (top) {
      parts.push(
        `${top.agentName ?? top.agentId} hit a ${top.streakCount}-run claude_quota_exhausted streak in the last ${top.windowMinutes}m`,
      );
    }
  }
  if (triggers.includes("opus_weekly_saturation") && snapshot.opusSaturation) {
    parts.push(
      `Opus weekly utilization at ${snapshot.opusSaturation.usedPercent}% (resets ${snapshot.opusSaturation.resetsAt ?? "unknown"})`,
    );
  }
  if (parts.length === 0) {
    return `Opus quota pressure detected for ${companyName}.`;
  }
  return parts.join("; ") + ".";
}

export function quotaWatcherService(db: Db, deps: QuotaWatcherDeps = {}) {
  const incidents = deps.quotaIncidents ?? quotaIncidentsService(db);
  const fetchProviderQuotaWindows =
    deps.fetchProviderQuotaWindows ?? fetchAllQuotaWindows;
  const semaphore = deps.semaphore ?? defaultSemaphoreShim();
  const nowFn = deps.now ?? (() => new Date());

  async function loadCompanyById(companyId: string) {
    return db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadAllCompanyIds(): Promise<string[]> {
    const rows = await db.select({ id: companies.id }).from(companies);
    return rows.map((row) => row.id);
  }

  async function loadAgentStreakRows(
    companyId: string,
    windowStart: Date,
  ): Promise<AgentStreakRow[]> {
    const rows = await db
      .select({
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        errorCode: heartbeatRuns.errorCode,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.finishedAt} is not null`,
          sql`${heartbeatRuns.finishedAt} >= ${windowStart}`,
        ),
      );
    return rows.map((row) => ({
      agentId: row.agentId,
      agentName: row.agentName ?? null,
      errorCode: row.errorCode ?? null,
      finishedAt: row.finishedAt ?? null,
    }));
  }

  async function findOpenQuotaApproval(companyId: string) {
    return db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.type, QUOTA_INCIDENT_APPROVAL_TYPE),
          inArray(approvals.status, ["pending", "revision_requested"]),
          sql`${approvals.payload}->>'subtype' = ${QUOTA_INCIDENT_APPROVAL_SUBTYPE}`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function evaluateCompany(
    companyId: string,
  ): Promise<QuotaWatcherTickResult> {
    const generatedAt = nowFn();
    const company = await loadCompanyById(companyId);

    const capacity = resolveOpusConcurrencyCapacity(company?.metadata ?? null);
    const throttle: QuotaWatcherThrottleSnapshot = {
      provider: "anthropic",
      modelFamily: "opus",
      capacity,
      inflight: semaphore.getInflightCount(companyId),
      waiters: semaphore.getWaiterCount(companyId),
    };

    if (!company) {
      const emptyIncidents: QuotaIncidentsResult = {
        windowMinutes: QUOTA_WATCHER_COMPANY_INCIDENT_WINDOW_MINUTES,
        windowStart: new Date(
          generatedAt.getTime() -
            QUOTA_WATCHER_COMPANY_INCIDENT_WINDOW_MINUTES * 60 * 1000,
        ),
        windowEnd: generatedAt,
        total: 0,
        totalByCode: {
          claude_quota_exhausted: 0,
          claude_rate_limited: 0,
          claude_provider_5xx: 0,
        },
        oldestAt: null,
        newestAt: null,
        byAgent: [],
      };
      return {
        companyId,
        triggers: [],
        approvalId: null,
        approvalCreated: false,
        skippedReason: "company_missing",
        metricsSnapshot: buildSnapshot(
          emptyIncidents,
          [],
          null,
          throttle,
          generatedAt,
        ),
      };
    }

    const incidentsResult = await incidents.listRecent(companyId, {
      windowMinutes: QUOTA_WATCHER_COMPANY_INCIDENT_WINDOW_MINUTES,
      now: generatedAt,
    });

    const streakWindowStart = new Date(
      generatedAt.getTime() -
        QUOTA_WATCHER_AGENT_STREAK_WINDOW_MINUTES * 60 * 1000,
    );
    const streakRows = await loadAgentStreakRows(companyId, streakWindowStart);
    const agentStreaks = computeQuotaStreaksFromRows(
      streakRows,
      QUOTA_WATCHER_AGENT_STREAK_WINDOW_MINUTES,
    );

    let providerQuotas: ProviderQuotaResult[] = [];
    try {
      providerQuotas = await fetchProviderQuotaWindows();
    } catch {
      providerQuotas = [];
    }
    const opusSaturation = findOpusWeeklySaturation(providerQuotas);

    const triggers: QuotaWatcherTriggerReason[] = [];
    if (
      incidentsResult.totalByCode.claude_quota_exhausted >=
      QUOTA_WATCHER_COMPANY_INCIDENT_THRESHOLD
    ) {
      triggers.push("company_quota_volume");
    }
    if (
      agentStreaks.some(
        (s) => s.streakCount >= QUOTA_WATCHER_AGENT_STREAK_THRESHOLD,
      )
    ) {
      triggers.push("agent_quota_streak");
    }
    if (
      opusSaturation &&
      opusSaturation.usedPercent >=
        QUOTA_WATCHER_OPUS_UTILIZATION_THRESHOLD_PERCENT
    ) {
      triggers.push("opus_weekly_saturation");
    }

    const snapshot = buildSnapshot(
      incidentsResult,
      agentStreaks,
      opusSaturation,
      throttle,
      generatedAt,
    );

    if (triggers.length === 0) {
      return {
        companyId,
        triggers,
        approvalId: null,
        approvalCreated: false,
        skippedReason: "no_triggers",
        metricsSnapshot: snapshot,
      };
    }

    const existing = await findOpenQuotaApproval(companyId);
    if (existing) {
      return {
        companyId,
        triggers,
        approvalId: existing.id,
        approvalCreated: false,
        skippedReason: "dedup_existing_approval",
        metricsSnapshot: snapshot,
      };
    }

    const summary = buildApprovalSummary(company.name, triggers, snapshot);
    const recommendedActions = buildRecommendedActions(companyId);

    const inserted = await db
      .insert(approvals)
      .values({
        companyId,
        type: QUOTA_INCIDENT_APPROVAL_TYPE,
        status: "pending",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {
          subtype: QUOTA_INCIDENT_APPROVAL_SUBTYPE,
          title: "Opus quota pressure detected",
          summary,
          triggers,
          metrics: snapshot,
          recommendedActions,
        },
      })
      .returning({ id: approvals.id })
      .then((rows) => rows[0] ?? null);

    return {
      companyId,
      triggers,
      approvalId: inserted?.id ?? null,
      approvalCreated: inserted != null,
      skippedReason: null,
      metricsSnapshot: snapshot,
    };
  }

  async function tickAllCompanies(): Promise<QuotaWatcherTickAllResult> {
    const companyIds = await loadAllCompanyIds();
    const results: QuotaWatcherTickResult[] = [];
    for (const companyId of companyIds) {
      try {
        const result = await evaluateCompany(companyId);
        results.push(result);
      } catch {
        // Single-company evaluation failures must not stop the rest of the
        // sweep. The caller logs the aggregate result; we omit the failed
        // company from `results` so the next tick re-evaluates it cleanly.
      }
    }
    return {
      scanned: companyIds.length,
      triggered: results.filter((r) => r.triggers.length > 0).length,
      approvalsCreated: results.filter((r) => r.approvalCreated).length,
      results,
    };
  }

  async function getThrottleSnapshot(
    companyId: string,
  ): Promise<QuotaWatcherThrottleSnapshot> {
    const company = await loadCompanyById(companyId);
    return {
      provider: "anthropic",
      modelFamily: "opus",
      capacity: resolveOpusConcurrencyCapacity(company?.metadata ?? null),
      inflight: semaphore.getInflightCount(companyId),
      waiters: semaphore.getWaiterCount(companyId),
    };
  }

  // ---------------------------------------------------------------------------
  // PMSA-21 / PMSA-11 §3.5 Phase 3 — event-driven quota exhaustion consumer.
  // ---------------------------------------------------------------------------

  async function loadQuotaExhaustedEvents(
    companyId: string,
    sinceCreatedAt: Date,
  ) {
    return db
      .select({
        id: heartbeatRunEvents.id,
        runId: heartbeatRunEvents.runId,
        agentIdFromEvent: heartbeatRunEvents.agentId,
        payload: heartbeatRunEvents.payload,
        createdAt: heartbeatRunEvents.createdAt,
        agentName: agents.name,
      })
      .from(heartbeatRunEvents)
      .leftJoin(agents, eq(agents.id, heartbeatRunEvents.agentId))
      .where(
        and(
          eq(heartbeatRunEvents.companyId, companyId),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
          gte(heartbeatRunEvents.createdAt, sinceCreatedAt),
          // Postgres jsonb ->> coerces the boolean to "true" / "false".
          sql`${heartbeatRunEvents.payload}->>'quotaRetryExhausted' = 'true'`,
        ),
      )
      .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id));
  }

  async function loadIssueStatus(companyId: string, issueId: string) {
    return db
      .select({
        id: issues.id,
        status: issues.status,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenQuotaEventApproval(
    companyId: string,
    issueId: string,
    agentId: string,
  ) {
    return db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.type, QUOTA_EVENT_APPROVAL_TYPE),
          inArray(approvals.status, ["pending", "revision_requested"]),
          sql`${approvals.payload}->>'subtype' = ${QUOTA_EVENT_APPROVAL_SUBTYPE}`,
          sql`${approvals.payload}->>'issueId' = ${issueId}`,
          sql`${approvals.payload}->>'agentId' = ${agentId}`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function consumeQuotaExhaustionEvents(
    companyId: string,
  ): Promise<QuotaEventConsumeResult> {
    const generatedAt = nowFn();
    const lookbackStart = new Date(
      generatedAt.getTime() - QUOTA_EVENT_LOOKBACK_MINUTES * 60 * 1000,
    );

    const company = await loadCompanyById(companyId);
    if (!company) {
      return {
        companyId,
        scannedEvents: 0,
        uniquePairs: 0,
        resumedIssues: 0,
        approvalsCreated: 0,
        approvalsDeduped: 0,
        invalidPayloads: 0,
        quotaRecovered: true,
        results: [],
      };
    }

    let providerQuotas: ProviderQuotaResult[] = [];
    try {
      providerQuotas = await fetchProviderQuotaWindows();
    } catch {
      providerQuotas = [];
    }
    const opusSaturation = findOpusWeeklySaturation(providerQuotas);
    const quotaRecovered = isOpusQuotaRecovered(opusSaturation, generatedAt);

    const events = await loadQuotaExhaustedEvents(companyId, lookbackStart);

    const seenPairs = new Set<string>();
    const results: QuotaEventResult[] = [];
    let resumedIssues = 0;
    let approvalsCreated = 0;
    let approvalsDeduped = 0;
    let invalidPayloads = 0;

    for (const event of events) {
      const parsed = parseQuotaRetryExhaustedPayload(event.payload);
      if (!parsed) {
        invalidPayloads += 1;
        results.push({
          eventId: event.id,
          runId: event.runId,
          agentId: event.agentIdFromEvent ?? null,
          agentName: event.agentName ?? null,
          issueId: null,
          errorCode: null,
          attempts: null,
          outcome: "skipped_invalid_payload",
          approvalId: null,
          resumedAt: null,
        });
        continue;
      }

      // Per spec: dedupe to one action per (issueId, agentId) pair within the
      // lookback window. The event always carries `issueId`; `agentId` may be
      // missing on the "issue already blocked / cancelled" branch, in which
      // case we fall back to the run's agent so we still dedupe sanely.
      const agentIdForDedup = parsed.agentId ?? event.agentIdFromEvent ?? null;
      if (!agentIdForDedup) {
        results.push({
          eventId: event.id,
          runId: event.runId,
          agentId: null,
          agentName: event.agentName ?? null,
          issueId: parsed.issueId,
          errorCode: parsed.errorCode,
          attempts: parsed.attempts,
          outcome: "agent_unknown",
          approvalId: null,
          resumedAt: null,
        });
        continue;
      }
      const pairKey = `${parsed.issueId}::${agentIdForDedup}`;
      if (seenPairs.has(pairKey)) {
        results.push({
          eventId: event.id,
          runId: event.runId,
          agentId: agentIdForDedup,
          agentName: event.agentName ?? null,
          issueId: parsed.issueId,
          errorCode: parsed.errorCode,
          attempts: parsed.attempts,
          outcome: "deduped_in_tick",
          approvalId: null,
          resumedAt: null,
        });
        continue;
      }
      seenPairs.add(pairKey);

      const issue = await loadIssueStatus(companyId, parsed.issueId);
      if (!issue) {
        results.push({
          eventId: event.id,
          runId: event.runId,
          agentId: agentIdForDedup,
          agentName: event.agentName ?? null,
          issueId: parsed.issueId,
          errorCode: parsed.errorCode,
          attempts: parsed.attempts,
          outcome: "issue_missing",
          approvalId: null,
          resumedAt: null,
        });
        continue;
      }

      // Quota recovered → flip blocked → todo and wake the agent so the
      // executor picks it up on its next heartbeat without waiting for the
      // 5-minute scheduler tick.
      if (quotaRecovered) {
        if (issue.status !== "blocked") {
          // Someone (board, another agent) already moved it; nothing to do.
          results.push({
            eventId: event.id,
            runId: event.runId,
            agentId: agentIdForDedup,
            agentName: event.agentName ?? null,
            issueId: parsed.issueId,
            errorCode: parsed.errorCode,
            attempts: parsed.attempts,
            outcome: "issue_already_unblocked",
            approvalId: null,
            resumedAt: null,
          });
          continue;
        }

        let resumed = false;
        if (deps.issueResume) {
          try {
            const updated = await deps.issueResume(parsed.issueId, {
              agentId: agentIdForDedup,
              nextStatus: "todo",
            });
            resumed = updated?.status === "todo";
          } catch {
            // Resume failures must not stop the sweep; surface as a no-op
            // outcome so the caller can log and the next tick can retry.
            resumed = false;
          }
        } else {
          // No injected resumer — record what we would have done and rely on
          // the next caller (or manual board action) to push the status.
          resumed = false;
        }

        if (resumed) {
          if (deps.enqueueWakeup) {
            try {
              await deps.enqueueWakeup(agentIdForDedup, {
                reason: "quota_retry_exhausted_recovered",
                source: "automation",
                contextSnapshot: {
                  issueId: parsed.issueId,
                  errorCode: parsed.errorCode,
                  resumedFromBlocked: true,
                },
              });
            } catch {
              // Wake failure is non-fatal — agent will still pick up the
              // issue on its next scheduled heartbeat.
            }
          }
          resumedIssues += 1;
          results.push({
            eventId: event.id,
            runId: event.runId,
            agentId: agentIdForDedup,
            agentName: event.agentName ?? null,
            issueId: parsed.issueId,
            errorCode: parsed.errorCode,
            attempts: parsed.attempts,
            outcome: "issue_resumed",
            approvalId: null,
            resumedAt: generatedAt.toISOString(),
          });
        } else {
          // Treat a failed resume as "still blocked" — fall through to the
          // approval branch below so the board still hears about it.
          const approvalOutcome = await ensureBoardApproval(
            company.name,
            companyId,
            parsed,
            agentIdForDedup,
            event.agentName ?? null,
            opusSaturation,
            generatedAt,
            issue.identifier ?? null,
          );
          if (approvalOutcome.created) approvalsCreated += 1;
          else if (approvalOutcome.deduped) approvalsDeduped += 1;
          results.push({
            eventId: event.id,
            runId: event.runId,
            agentId: agentIdForDedup,
            agentName: event.agentName ?? null,
            issueId: parsed.issueId,
            errorCode: parsed.errorCode,
            attempts: parsed.attempts,
            outcome: approvalOutcome.created
              ? "approval_created"
              : "approval_skipped_existing",
            approvalId: approvalOutcome.approvalId,
            resumedAt: null,
          });
        }
        continue;
      }

      // Quota NOT recovered → page the board exactly once per
      // (issueId, agentId) pair within the dedup window.
      const approvalOutcome = await ensureBoardApproval(
        company.name,
        companyId,
        parsed,
        agentIdForDedup,
        event.agentName ?? null,
        opusSaturation,
        generatedAt,
        issue.identifier ?? null,
      );
      if (approvalOutcome.created) approvalsCreated += 1;
      else if (approvalOutcome.deduped) approvalsDeduped += 1;
      results.push({
        eventId: event.id,
        runId: event.runId,
        agentId: agentIdForDedup,
        agentName: event.agentName ?? null,
        issueId: parsed.issueId,
        errorCode: parsed.errorCode,
        attempts: parsed.attempts,
        outcome: approvalOutcome.created
          ? "approval_created"
          : "approval_skipped_existing",
        approvalId: approvalOutcome.approvalId,
        resumedAt: null,
      });
    }

    return {
      companyId,
      scannedEvents: events.length,
      uniquePairs: seenPairs.size,
      resumedIssues,
      approvalsCreated,
      approvalsDeduped,
      invalidPayloads,
      quotaRecovered,
      results,
    };
  }

  async function ensureBoardApproval(
    companyName: string,
    companyId: string,
    parsed: QuotaRetryExhaustedPayload,
    agentId: string,
    agentName: string | null,
    opusSaturation: QuotaWatcherOpusSaturation | null,
    generatedAt: Date,
    issueIdentifier: string | null,
  ): Promise<{
    created: boolean;
    deduped: boolean;
    approvalId: string | null;
  }> {
    const existing = await findOpenQuotaEventApproval(
      companyId,
      parsed.issueId,
      agentId,
    );
    if (existing) {
      return { created: false, deduped: true, approvalId: existing.id };
    }

    const errorLabel =
      parsed.errorCode === "claude_rate_limited"
        ? "Anthropic API rate limit"
        : "Anthropic Opus quota exhaustion";
    const issueLabel = issueIdentifier ?? parsed.issueId;
    const summary = [
      `${agentName ?? agentId} hit ${errorLabel} on ${issueLabel}`,
      `(${parsed.attempts}/${parsed.maxAttempts} retries) and quota has not yet recovered.`,
      opusSaturation
        ? `Opus weekly utilization at ${opusSaturation.usedPercent}% (resets ${opusSaturation.resetsAt ?? "unknown"}).`
        : null,
    ]
      .filter((part): part is string => part != null)
      .join(" ");

    const inserted = await db
      .insert(approvals)
      .values({
        companyId,
        type: QUOTA_EVENT_APPROVAL_TYPE,
        status: "pending",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {
          subtype: QUOTA_EVENT_APPROVAL_SUBTYPE,
          title: `Quota exhausted: ${issueLabel}`,
          summary,
          companyName,
          issueId: parsed.issueId,
          issueIdentifier,
          agentId,
          agentName,
          errorCode: parsed.errorCode,
          attempts: parsed.attempts,
          maxAttempts: parsed.maxAttempts,
          detectedAt: generatedAt.toISOString(),
          opusSaturation: opusSaturation ?? null,
          recommendedActions: buildRecommendedActions(companyId),
        },
      })
      .returning({ id: approvals.id })
      .then((rows) => rows[0] ?? null);

    return {
      created: inserted != null,
      deduped: false,
      approvalId: inserted?.id ?? null,
    };
  }

  async function tickAllCompaniesQuotaEvents(): Promise<{
    scanned: number;
    resumedIssues: number;
    approvalsCreated: number;
    approvalsDeduped: number;
    results: QuotaEventConsumeResult[];
  }> {
    const companyIds = await loadAllCompanyIds();
    const results: QuotaEventConsumeResult[] = [];
    for (const companyId of companyIds) {
      try {
        results.push(await consumeQuotaExhaustionEvents(companyId));
      } catch {
        // Single-company failures must not stop the sweep.
      }
    }
    return {
      scanned: companyIds.length,
      resumedIssues: results.reduce((acc, r) => acc + r.resumedIssues, 0),
      approvalsCreated: results.reduce((acc, r) => acc + r.approvalsCreated, 0),
      approvalsDeduped: results.reduce((acc, r) => acc + r.approvalsDeduped, 0),
      results,
    };
  }

  return {
    evaluateCompany,
    tickAllCompanies,
    getThrottleSnapshot,
    consumeQuotaExhaustionEvents,
    tickAllCompaniesQuotaEvents,
  };
}

export type QuotaWatcherService = ReturnType<typeof quotaWatcherService>;
