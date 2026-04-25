import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  computeQuotaStreaksFromRows,
  findOpusWeeklySaturation,
  isOpusQuotaRecovered,
  parseQuotaRetryExhaustedPayload,
  QUOTA_EVENT_APPROVAL_SUBTYPE,
  QUOTA_EVENT_APPROVAL_TYPE,
  QUOTA_INCIDENT_APPROVAL_SUBTYPE,
  QUOTA_INCIDENT_APPROVAL_TYPE,
  quotaWatcherService,
} from "../services/quota-watcher.js";
import type { ProviderQuotaResult } from "@paperclipai/shared";

// Pure-function helpers don't need the embedded postgres harness; we keep them
// in their own describe blocks so they run on hosts where embedded postgres
// is unsupported (CI matrix coverage).

describe("computeQuotaStreaksFromRows", () => {
  it("counts the consecutive claude_quota_exhausted prefix per agent", () => {
    const agentA = randomUUID();
    const agentB = randomUUID();
    const t = (offsetSec: number) =>
      new Date(Date.UTC(2026, 3, 26, 12, 0) - offsetSec * 1000);

    const streaks = computeQuotaStreaksFromRows(
      [
        // Agent A: 3 most recent are quota_exhausted, then a clean run.
        {
          agentId: agentA,
          agentName: "CEO",
          errorCode: "claude_quota_exhausted",
          finishedAt: t(0),
        },
        {
          agentId: agentA,
          agentName: "CEO",
          errorCode: "claude_quota_exhausted",
          finishedAt: t(60),
        },
        {
          agentId: agentA,
          agentName: "CEO",
          errorCode: "claude_quota_exhausted",
          finishedAt: t(120),
        },
        {
          agentId: agentA,
          agentName: "CEO",
          errorCode: null,
          finishedAt: t(180),
        },
        // Agent B: most recent is non-quota — streak is 0 even though older
        // runs were quota_exhausted.
        {
          agentId: agentB,
          agentName: "Engineer",
          errorCode: null,
          finishedAt: t(10),
        },
        {
          agentId: agentB,
          agentName: "Engineer",
          errorCode: "claude_quota_exhausted",
          finishedAt: t(70),
        },
      ],
      5,
    );

    expect(streaks).toHaveLength(1);
    expect(streaks[0]).toMatchObject({
      agentId: agentA,
      agentName: "CEO",
      streakCount: 3,
      windowMinutes: 5,
    });
  });

  it("ignores rows without a finishedAt timestamp", () => {
    const agentId = randomUUID();
    const streaks = computeQuotaStreaksFromRows(
      [
        {
          agentId,
          agentName: null,
          errorCode: "claude_quota_exhausted",
          finishedAt: null,
        },
      ],
      5,
    );
    expect(streaks).toHaveLength(0);
  });
});

describe("findOpusWeeklySaturation", () => {
  function buildResult(
    label: string,
    usedPercent: number | null,
  ): ProviderQuotaResult {
    return {
      provider: "anthropic",
      ok: true,
      windows: [
        {
          label,
          usedPercent,
          resetsAt: "2026-04-30T00:00:00.000Z",
          valueLabel: null,
        },
      ],
    };
  }

  it("matches the Opus-only weekly window case-insensitively", () => {
    const sat = findOpusWeeklySaturation([
      buildResult("Current week (Opus only)", 92),
    ]);
    expect(sat?.usedPercent).toBe(92);
  });

  it("returns null when the provider failed", () => {
    const sat = findOpusWeeklySaturation([
      {
        provider: "anthropic",
        ok: false,
        error: "boom",
        windows: [],
      },
    ]);
    expect(sat).toBeNull();
  });

  it("returns null when usedPercent is missing", () => {
    const sat = findOpusWeeklySaturation([
      buildResult("Current week (Opus only)", null),
    ]);
    expect(sat).toBeNull();
  });
});

describe("parseQuotaRetryExhaustedPayload (PMSA-21)", () => {
  const valid = {
    quotaRetryExhausted: true,
    errorCode: "claude_quota_exhausted",
    attempts: 3,
    maxAttempts: 3,
    issueId: "00000000-0000-0000-0000-000000000001",
    issueStatus: "blocked",
    agentId: "00000000-0000-0000-0000-000000000002",
  };

  it("accepts the payload PMSA-18 emits on the success branch", () => {
    expect(parseQuotaRetryExhaustedPayload(valid)).toEqual(valid);
  });

  it("accepts the already-blocked branch where agentId is omitted", () => {
    const { agentId: _omitted, ...withoutAgent } = valid;
    expect(parseQuotaRetryExhaustedPayload(withoutAgent)).toMatchObject({
      issueId: valid.issueId,
      issueStatus: valid.issueStatus,
      agentId: undefined,
    });
  });

  it("returns null when the marker flag is missing or false", () => {
    expect(
      parseQuotaRetryExhaustedPayload({ ...valid, quotaRetryExhausted: false }),
    ).toBeNull();
    const { quotaRetryExhausted: _omit, ...withoutFlag } = valid;
    expect(parseQuotaRetryExhaustedPayload(withoutFlag)).toBeNull();
  });

  it("returns null when required fields are missing or wrong type", () => {
    expect(
      parseQuotaRetryExhaustedPayload({ ...valid, issueId: undefined }),
    ).toBeNull();
    expect(
      parseQuotaRetryExhaustedPayload({ ...valid, attempts: "3" }),
    ).toBeNull();
    expect(parseQuotaRetryExhaustedPayload(null)).toBeNull();
    expect(parseQuotaRetryExhaustedPayload("not-an-object")).toBeNull();
  });
});

describe("isOpusQuotaRecovered (PMSA-21)", () => {
  const now = new Date("2026-04-26T12:00:00.000Z");

  it("treats a missing saturation reading as recovered", () => {
    expect(isOpusQuotaRecovered(null, now)).toBe(true);
  });

  it("treats utilization below the saturation threshold as recovered", () => {
    expect(
      isOpusQuotaRecovered(
        {
          provider: "anthropic",
          label: "Current week (Opus only)",
          usedPercent: 89,
          resetsAt: "2026-05-03T00:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
  });

  it("treats a passed resetsAt as recovered even at 100%", () => {
    expect(
      isOpusQuotaRecovered(
        {
          provider: "anthropic",
          label: "Current week (Opus only)",
          usedPercent: 100,
          resetsAt: "2026-04-26T11:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
  });

  it("treats high utilization with future reset as still saturated", () => {
    expect(
      isOpusQuotaRecovered(
        {
          provider: "anthropic",
          label: "Current week (Opus only)",
          usedPercent: 95,
          resetsAt: "2026-05-03T00:00:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quota watcher tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "quotaWatcherService.evaluateCompany (PMSA-19)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-quota-watcher-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      await db.delete(heartbeatRuns);
      await db.delete(approvals);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function seedCompany(name = "Paperclip") {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name,
        issuePrefix: `PAP-${companyId.slice(0, 8)}`,
        requireBoardApprovalForNewAgents: false,
      });
      return companyId;
    }

    async function seedAgent(companyId: string, name: string) {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    }

    async function seedRun(
      companyId: string,
      agentId: string,
      errorCode: string | null,
      finishedAt: Date,
    ) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: errorCode ? "failed" : "succeeded",
        errorCode,
        finishedAt,
        createdAt: finishedAt,
        updatedAt: finishedAt,
      });
    }

    function emptyQuotaWindows(): ProviderQuotaResult[] {
      return [
        {
          provider: "anthropic",
          ok: true,
          windows: [],
        },
      ];
    }

    it("does nothing when no triggers fire", async () => {
      const companyId = await seedCompany();
      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => emptyQuotaWindows(),
        semaphore: {
          getInflightCount: () => 0,
          getWaiterCount: () => 0,
        },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
      });

      const result = await watcher.evaluateCompany(companyId);

      expect(result.triggers).toEqual([]);
      expect(result.skippedReason).toBe("no_triggers");
      expect(result.approvalCreated).toBe(false);

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(0);
    });

    it("opens an approval when company-wide volume crosses the threshold", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const now = new Date("2026-04-26T12:00:00.000Z");
      // 5 quota_exhausted runs in the last 30 minutes is the threshold.
      for (let i = 0; i < 5; i++) {
        await seedRun(
          companyId,
          agentId,
          "claude_quota_exhausted",
          new Date(now.getTime() - (i + 1) * 60 * 1000),
        );
      }

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => emptyQuotaWindows(),
        semaphore: {
          getInflightCount: () => 0,
          getWaiterCount: () => 0,
        },
        now: () => now,
      });

      const result = await watcher.evaluateCompany(companyId);

      expect(result.triggers).toContain("company_quota_volume");
      expect(result.approvalCreated).toBe(true);
      expect(result.approvalId).toBeTruthy();

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0]?.type).toBe(QUOTA_INCIDENT_APPROVAL_TYPE);
      const payload = approvalRows[0]?.payload as Record<string, unknown>;
      expect(payload.subtype).toBe(QUOTA_INCIDENT_APPROVAL_SUBTYPE);
      expect(payload.triggers).toEqual(
        expect.arrayContaining(["company_quota_volume"]),
      );
      expect(payload.recommendedActions).toBeInstanceOf(Array);
    });

    it("dedups when an open approval of the same subtype already exists", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const now = new Date("2026-04-26T12:00:00.000Z");
      for (let i = 0; i < 6; i++) {
        await seedRun(
          companyId,
          agentId,
          "claude_quota_exhausted",
          new Date(now.getTime() - (i + 1) * 60 * 1000),
        );
      }

      const existingApprovalId = randomUUID();
      await db.insert(approvals).values({
        id: existingApprovalId,
        companyId,
        type: QUOTA_INCIDENT_APPROVAL_TYPE,
        status: "pending",
        payload: { subtype: QUOTA_INCIDENT_APPROVAL_SUBTYPE },
      });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => emptyQuotaWindows(),
        semaphore: {
          getInflightCount: () => 0,
          getWaiterCount: () => 0,
        },
        now: () => now,
      });

      const result = await watcher.evaluateCompany(companyId);

      expect(result.skippedReason).toBe("dedup_existing_approval");
      expect(result.approvalCreated).toBe(false);
      expect(result.approvalId).toBe(existingApprovalId);

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(1);
    });

    it("re-arms after the prior approval is resolved", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const now = new Date("2026-04-26T12:00:00.000Z");
      for (let i = 0; i < 6; i++) {
        await seedRun(
          companyId,
          agentId,
          "claude_quota_exhausted",
          new Date(now.getTime() - (i + 1) * 60 * 1000),
        );
      }

      const previousApprovalId = randomUUID();
      await db.insert(approvals).values({
        id: previousApprovalId,
        companyId,
        type: QUOTA_INCIDENT_APPROVAL_TYPE,
        status: "approved",
        payload: { subtype: QUOTA_INCIDENT_APPROVAL_SUBTYPE },
        decidedAt: new Date(now.getTime() - 10 * 60 * 1000),
      });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => emptyQuotaWindows(),
        semaphore: {
          getInflightCount: () => 0,
          getWaiterCount: () => 0,
        },
        now: () => now,
      });

      const result = await watcher.evaluateCompany(companyId);

      expect(result.approvalCreated).toBe(true);
      expect(result.approvalId).not.toBe(previousApprovalId);

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(2);
    });

    it("fires on Opus weekly saturation alone", async () => {
      const companyId = await seedCompany();
      const now = new Date("2026-04-26T12:00:00.000Z");

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => [
          {
            provider: "anthropic",
            ok: true,
            windows: [
              {
                label: "Current week (Opus only)",
                usedPercent: 95,
                resetsAt: "2026-04-30T00:00:00.000Z",
                valueLabel: null,
              },
            ],
          },
        ],
        semaphore: {
          getInflightCount: () => 0,
          getWaiterCount: () => 0,
        },
        now: () => now,
      });

      const result = await watcher.evaluateCompany(companyId);

      expect(result.triggers).toEqual(["opus_weekly_saturation"]);
      expect(result.approvalCreated).toBe(true);
      expect(result.metricsSnapshot.opusSaturation?.usedPercent).toBe(95);
    });

    it("fires on a 3-run agent streak in the last 5 minutes", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const now = new Date("2026-04-26T12:00:00.000Z");
      // 3 quota_exhausted runs in the last 5 minutes, with no clean run in
      // between, so the agent streak detector picks them up.
      for (let i = 0; i < 3; i++) {
        await seedRun(
          companyId,
          agentId,
          "claude_quota_exhausted",
          new Date(now.getTime() - (i + 1) * 30 * 1000),
        );
      }

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => emptyQuotaWindows(),
        semaphore: {
          getInflightCount: () => 0,
          getWaiterCount: () => 0,
        },
        now: () => now,
      });

      const result = await watcher.evaluateCompany(companyId);

      expect(result.triggers).toContain("agent_quota_streak");
      expect(result.approvalCreated).toBe(true);
      expect(result.metricsSnapshot.agentStreaks).toHaveLength(1);
      expect(result.metricsSnapshot.agentStreaks[0]?.streakCount).toBe(3);
    });

    it("does not fire when a clean run interrupts the streak", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const now = new Date("2026-04-26T12:00:00.000Z");
      // Most recent run is clean — streak count is 0 even though older runs
      // were quota_exhausted.
      await seedRun(
        companyId,
        agentId,
        null,
        new Date(now.getTime() - 30 * 1000),
      );
      for (let i = 1; i < 4; i++) {
        await seedRun(
          companyId,
          agentId,
          "claude_quota_exhausted",
          new Date(now.getTime() - (i + 1) * 30 * 1000),
        );
      }

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => emptyQuotaWindows(),
        semaphore: {
          getInflightCount: () => 0,
          getWaiterCount: () => 0,
        },
        now: () => now,
      });

      const result = await watcher.evaluateCompany(companyId);

      expect(result.triggers).not.toContain("agent_quota_streak");
    });
  },
);

describeEmbeddedPostgres(
  "quotaWatcherService.consumeQuotaExhaustionEvents (PMSA-21)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-quota-event-watcher-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(approvals);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function seedCompany(name = "Paperclip") {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name,
        issuePrefix: `PAP-${companyId.slice(0, 8)}`,
        requireBoardApprovalForNewAgents: false,
      });
      return companyId;
    }

    async function seedAgent(companyId: string, name: string) {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    }

    async function seedRun(companyId: string, agentId: string) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        errorCode: "claude_quota_exhausted",
        finishedAt: new Date(),
      });
      return id;
    }

    async function seedIssue(
      companyId: string,
      agentId: string,
      status: "blocked" | "todo" | "in_progress" = "blocked",
      identifier: string = "PAP-99",
    ) {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId,
        title: "Sample blocked issue",
        status,
        priority: "medium",
        assigneeAgentId: agentId,
        identifier,
      });
      return id;
    }

    async function seedQuotaExhaustedEvent(args: {
      companyId: string;
      runId: string;
      agentId: string;
      issueId: string;
      issueStatus?: string;
      errorCode?: string;
      attempts?: number;
      maxAttempts?: number;
      includeAgentIdInPayload?: boolean;
      createdAt?: Date;
    }) {
      const includeAgentIdInPayload = args.includeAgentIdInPayload ?? true;
      const payload: Record<string, unknown> = {
        quotaRetryExhausted: true,
        errorCode: args.errorCode ?? "claude_quota_exhausted",
        attempts: args.attempts ?? 3,
        maxAttempts: args.maxAttempts ?? 3,
        issueId: args.issueId,
        issueStatus: args.issueStatus ?? "blocked",
      };
      if (includeAgentIdInPayload) payload.agentId = args.agentId;

      await db.insert(heartbeatRunEvents).values({
        companyId: args.companyId,
        runId: args.runId,
        agentId: args.agentId,
        seq: 1,
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: "quota_retry_exhausted",
        payload,
        createdAt: args.createdAt ?? new Date(),
      });
    }

    function recoveredQuotaWindows(): ProviderQuotaResult[] {
      return [
        {
          provider: "anthropic",
          ok: true,
          windows: [
            {
              label: "Current week (Opus only)",
              usedPercent: 60,
              resetsAt: "2026-05-03T00:00:00.000Z",
              valueLabel: null,
            },
          ],
        },
      ];
    }

    function saturatedQuotaWindows(): ProviderQuotaResult[] {
      return [
        {
          provider: "anthropic",
          ok: true,
          windows: [
            {
              label: "Current week (Opus only)",
              usedPercent: 99,
              resetsAt: "2026-05-03T00:00:00.000Z",
              valueLabel: null,
            },
          ],
        },
      ];
    }

    it("resumes a blocked issue when quota has recovered and wakes the agent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const runId = await seedRun(companyId, agentId);
      const issueId = await seedIssue(companyId, agentId, "blocked", "PAP-21");
      await seedQuotaExhaustedEvent({ companyId, runId, agentId, issueId });

      const wakes: Array<{
        agentId: string;
        reason: string;
        contextSnapshot?: Record<string, unknown>;
      }> = [];
      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => recoveredQuotaWindows(),
        semaphore: { getInflightCount: () => 0, getWaiterCount: () => 0 },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
        issueResume: async (id, args) => {
          const updated = await db
            .update(issues)
            .set({ status: args.nextStatus, updatedAt: new Date() })
            .where(eq(issues.id, id))
            .returning();
          return updated[0] ?? null;
        },
        enqueueWakeup: async (target, opts) => {
          wakes.push({
            agentId: target,
            reason: opts.reason,
            contextSnapshot: opts.contextSnapshot,
          });
          return { id: randomUUID() };
        },
      });

      const result = await watcher.consumeQuotaExhaustionEvents(companyId);

      expect(result.scannedEvents).toBe(1);
      expect(result.uniquePairs).toBe(1);
      expect(result.resumedIssues).toBe(1);
      expect(result.approvalsCreated).toBe(0);
      expect(result.quotaRecovered).toBe(true);
      expect(result.results[0]?.outcome).toBe("issue_resumed");

      const issueRow = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(issueRow[0]?.status).toBe("todo");

      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.agentId).toBe(agentId);
      expect(wakes[0]?.reason).toBe("quota_retry_exhausted_recovered");
      expect(wakes[0]?.contextSnapshot?.issueId).toBe(issueId);
    });

    it("opens one approval per issue/agent pair when quota is still saturated", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const runId = await seedRun(companyId, agentId);
      const issueId = await seedIssue(companyId, agentId, "blocked", "PAP-21");
      await seedQuotaExhaustedEvent({ companyId, runId, agentId, issueId });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => saturatedQuotaWindows(),
        semaphore: { getInflightCount: () => 0, getWaiterCount: () => 0 },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
      });

      const result = await watcher.consumeQuotaExhaustionEvents(companyId);

      expect(result.quotaRecovered).toBe(false);
      expect(result.approvalsCreated).toBe(1);
      expect(result.resumedIssues).toBe(0);
      expect(result.results[0]?.outcome).toBe("approval_created");

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0]?.type).toBe(QUOTA_EVENT_APPROVAL_TYPE);
      const payload = approvalRows[0]?.payload as Record<string, unknown>;
      expect(payload.subtype).toBe(QUOTA_EVENT_APPROVAL_SUBTYPE);
      expect(payload.issueId).toBe(issueId);
      expect(payload.agentId).toBe(agentId);
      expect(payload.errorCode).toBe("claude_quota_exhausted");
    });

    it("dedups duplicate events for the same issue/agent within a tick", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const runId1 = await seedRun(companyId, agentId);
      const runId2 = await seedRun(companyId, agentId);
      const issueId = await seedIssue(companyId, agentId, "blocked", "PAP-21");
      await seedQuotaExhaustedEvent({
        companyId,
        runId: runId1,
        agentId,
        issueId,
        createdAt: new Date("2026-04-26T11:55:00.000Z"),
      });
      await seedQuotaExhaustedEvent({
        companyId,
        runId: runId2,
        agentId,
        issueId,
        createdAt: new Date("2026-04-26T11:58:00.000Z"),
      });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => saturatedQuotaWindows(),
        semaphore: { getInflightCount: () => 0, getWaiterCount: () => 0 },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
      });

      const result = await watcher.consumeQuotaExhaustionEvents(companyId);

      expect(result.scannedEvents).toBe(2);
      expect(result.uniquePairs).toBe(1);
      expect(result.approvalsCreated).toBe(1);
      const dedupResult = result.results.find(
        (r) => r.outcome === "deduped_in_tick",
      );
      expect(dedupResult).toBeTruthy();

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(1);
    });

    it("dedups against a pre-existing approval for the same issue/agent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const runId = await seedRun(companyId, agentId);
      const issueId = await seedIssue(companyId, agentId, "blocked", "PAP-21");
      await seedQuotaExhaustedEvent({ companyId, runId, agentId, issueId });

      // Pre-existing approval — watcher must not duplicate it.
      const existingApprovalId = randomUUID();
      await db.insert(approvals).values({
        id: existingApprovalId,
        companyId,
        type: QUOTA_EVENT_APPROVAL_TYPE,
        status: "pending",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {
          subtype: QUOTA_EVENT_APPROVAL_SUBTYPE,
          issueId,
          agentId,
          title: "previous",
          summary: "previous",
        },
      });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => saturatedQuotaWindows(),
        semaphore: { getInflightCount: () => 0, getWaiterCount: () => 0 },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
      });

      const result = await watcher.consumeQuotaExhaustionEvents(companyId);

      expect(result.approvalsCreated).toBe(0);
      expect(result.approvalsDeduped).toBe(1);
      expect(result.results[0]?.outcome).toBe("approval_skipped_existing");
      expect(result.results[0]?.approvalId).toBe(existingApprovalId);

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(1);
    });

    it("treats an already-unblocked issue as a no-op when quota recovered", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const runId = await seedRun(companyId, agentId);
      // Issue was unblocked by the board / another path before the watcher
      // tick fired — we should not re-resume or page.
      const issueId = await seedIssue(companyId, agentId, "todo", "PAP-21");
      await seedQuotaExhaustedEvent({ companyId, runId, agentId, issueId });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => recoveredQuotaWindows(),
        semaphore: { getInflightCount: () => 0, getWaiterCount: () => 0 },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
        issueResume: async () => {
          throw new Error(
            "issueResume must not be called when issue is already unblocked",
          );
        },
      });

      const result = await watcher.consumeQuotaExhaustionEvents(companyId);

      expect(result.resumedIssues).toBe(0);
      expect(result.approvalsCreated).toBe(0);
      expect(result.results[0]?.outcome).toBe("issue_already_unblocked");
    });

    it("records issue_missing when the referenced issue has been deleted", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const runId = await seedRun(companyId, agentId);
      const ghostIssueId = randomUUID();
      await seedQuotaExhaustedEvent({
        companyId,
        runId,
        agentId,
        issueId: ghostIssueId,
      });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => recoveredQuotaWindows(),
        semaphore: { getInflightCount: () => 0, getWaiterCount: () => 0 },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
      });

      const result = await watcher.consumeQuotaExhaustionEvents(companyId);

      expect(result.results[0]?.outcome).toBe("issue_missing");
      expect(result.resumedIssues).toBe(0);
      expect(result.approvalsCreated).toBe(0);
    });

    it("ignores events older than the lookback window", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Engineer");
      const runId = await seedRun(companyId, agentId);
      const issueId = await seedIssue(companyId, agentId, "blocked", "PAP-21");
      // 31 minutes ago — outside the 30-min lookback.
      await seedQuotaExhaustedEvent({
        companyId,
        runId,
        agentId,
        issueId,
        createdAt: new Date("2026-04-26T11:29:00.000Z"),
      });

      const watcher = quotaWatcherService(db, {
        fetchProviderQuotaWindows: async () => recoveredQuotaWindows(),
        semaphore: { getInflightCount: () => 0, getWaiterCount: () => 0 },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
      });

      const result = await watcher.consumeQuotaExhaustionEvents(companyId);

      expect(result.scannedEvents).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  },
);
