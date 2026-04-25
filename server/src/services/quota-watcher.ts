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

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, heartbeatRuns } from "@paperclipai/db";
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

  return {
    evaluateCompany,
    tickAllCompanies,
    getThrottleSnapshot,
  };
}

export type QuotaWatcherService = ReturnType<typeof quotaWatcherService>;
