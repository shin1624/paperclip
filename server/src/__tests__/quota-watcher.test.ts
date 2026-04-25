import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  computeQuotaStreaksFromRows,
  findOpusWeeklySaturation,
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
