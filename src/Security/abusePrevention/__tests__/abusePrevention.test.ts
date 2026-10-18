import fs from "fs";
import os from "os";
import path from "path";
import { Request, Response } from "express";
import {
  abuseSubjectKey,
  AbusePreventionService,
  ANOMALY_POLICY_ID,
  ESCALATION_POLICY_ID,
} from "../AbusePreventionService";
import { applyAbusePolicyOverrides, resolveAbusePolicy } from "../policyOverrides";
import { ExecutionGate, ExecutionGateRejectedError } from "../executionGate";
import { createAbusePreventionMiddleware } from "../httpMiddleware";
import { AbuseTelemetry } from "../telemetry";
import { AbuseEvent, AbusePolicy } from "../types";
import { JobQueueService, JobThrottledError } from "../../../jobs/jobQueue.service";
import { PolicyAction } from "../../../AuditLog/auditEvent.types";

const policy = (): AbusePolicy => ({
  rateLimits: [
    { id: "bot-command", surfaces: ["bot"], actions: ["*"], maxRequests: 2, windowMs: 1000, keyBy: ["userId"] },
    { id: "provider-call", surfaces: ["provider"], actions: ["*"], maxRequests: 100, windowMs: 1000, keyBy: ["userId"] },
  ],
  escalation: { violationThreshold: 3, windowMs: 10_000, baseBlockMs: 1000, maxBlockMs: 3000 },
  anomaly: { windowMs: 5000, challengeThreshold: 3, blockThreshold: 5 },
});

const bot = (userId: string | undefined, now: number) => ({
  surface: "bot" as const,
  action: "swap",
  subject: { userId },
  now,
});

describe("AbusePreventionService", () => {
  it("throttles per user and reports retry timing", async () => {
    const service = new AbusePreventionService(policy());
    await service.evaluate(bot("u1", 0));
    await service.evaluate(bot("u1", 10));
    const third = await service.evaluate(bot("u1", 20));

    expect(third).toMatchObject({ allowed: false, decision: "throttle", policyId: "bot-command", retryAfterMs: 980 });
    expect((await service.evaluate(bot("u2", 20))).allowed).toBe(true);
    expect((await service.evaluate(bot("u1", 1001))).allowed).toBe(true);
  });

  it("skips disabled rate limits", async () => {
    const p = policy();
    p.rateLimits![0].disabled = true;
    const service = new AbusePreventionService(p);
    for (let i = 0; i < 5; i++) expect((await service.evaluate(bot("u1", i))).allowed).toBe(true);
  });

  it("escalates repeated violations into a block that doubles and is capped", async () => {
    const service = new AbusePreventionService(policy());
    const events: AbuseEvent[] = [];
    service.onEvent((e) => events.push(e));

    // 2 allowed, then 3 violations → block level 1 (1000ms)
    for (let i = 0; i < 5; i++) await service.evaluate(bot("u1", 100 + i));
    const blocked = await service.evaluate(bot("u1", 200));
    expect(blocked).toMatchObject({ allowed: false, decision: "deny", policyId: ESCALATION_POLICY_ID });
    expect(blocked.retryAfterMs).toBe(904);
    expect(events.filter((e) => e.type === "escalated")).toHaveLength(1);
    expect(events.find((e) => e.type === "escalated")).toMatchObject({ level: 1, subjectKey: "user:u1" });

    // Repeat offence after the block expires → level 2 (2000ms), then capped at 3000ms.
    for (let i = 0; i < 5; i++) await service.evaluate(bot("u1", 2000 + i));
    expect(events.filter((e) => e.type === "escalated").pop()).toMatchObject({ level: 2, blockedUntil: 2004 + 2000 });
    for (let i = 0; i < 5; i++) await service.evaluate(bot("u1", 6000 + i));
    for (let i = 0; i < 5; i++) await service.evaluate(bot("u1", 12000 + i));
    expect(events.filter((e) => e.type === "escalated").pop()).toMatchObject({ level: 4, blockedUntil: 12004 + 3000 });

    expect(service.getStats(12005).activeBlocks).toEqual([{ subjectKey: "user:u1", until: 15004, level: 4 }]);
    expect(service.unblock("user:u1")).toBe(true);
    expect((await service.evaluate(bot("u1", 20000))).allowed).toBe(true);
  });

  it("does not escalate rule denials, so lifting a rule takes effect immediately", async () => {
    let blocked = true;
    const service = new AbusePreventionService({
      ...policy(),
      rules: [{ id: "blocked-ip", surfaces: ["api"], actions: ["*"], decision: "deny", reason: "blocked", match: () => blocked }],
    });
    const ctx = (now: number) => ({ surface: "api" as const, action: "*", subject: { ipAddress: "9.9.9.9" }, now });

    for (let i = 0; i < 10; i++) expect((await service.evaluate(ctx(i))).policyId).toBe("blocked-ip");
    blocked = false;
    expect((await service.evaluate(ctx(20))).allowed).toBe(true);
  });

  it("never escalates anonymous traffic", async () => {
    const service = new AbusePreventionService(policy());
    for (let i = 0; i < 20; i++) await service.evaluate(bot(undefined, i));
    expect(service.getStats(20).activeBlocks).toEqual([]);
    expect(abuseSubjectKey({ ipAddress: "unknown" })).toBeNull();
  });

  it("challenges bursts of failures and blocks past the block threshold", async () => {
    const service = new AbusePreventionService(policy());
    const ctx = (now: number) => ({ surface: "api" as const, action: "auth.login", subject: { ipAddress: "1.2.3.4" }, now });

    for (let i = 0; i < 3; i++) service.recordFailure(ctx(i), "login_failed");
    expect(await service.evaluate(ctx(10))).toMatchObject({ allowed: false, decision: "challenge", policyId: ANOMALY_POLICY_ID });

    service.recordFailure(ctx(11));
    service.recordFailure(ctx(12));
    expect(await service.evaluate(ctx(13))).toMatchObject({ decision: "deny", policyId: ESCALATION_POLICY_ID });
  });

  it("counts decisions for telemetry and survives throwing listeners", async () => {
    const service = new AbusePreventionService(policy());
    service.onEvent(() => {
      throw new Error("listener broke");
    });
    for (let i = 0; i < 3; i++) await service.evaluate(bot("u1", i));
    const stats = service.getStats();
    expect(stats.decisions.throttle).toBe(1);
    expect(stats.byPolicy["bot-command"]).toBe(1);
    expect(stats.bySurface.bot).toBe(1);
  });
});

describe("policy overrides", () => {
  it("applies valid overrides and reports invalid ones without applying them", () => {
    const { policy: next, warnings } = applyAbusePolicyOverrides(policy(), {
      rateLimits: {
        "bot-command": { maxRequests: 50, windowMs: -1, disabled: true },
        "no-such-limit": { maxRequests: 1 },
      },
      escalation: { baseBlockMs: 5000, nonsense: 1 } as never,
      anomaly: { challengeThreshold: 0 },
    });

    expect(next.rateLimits![0]).toMatchObject({ maxRequests: 50, windowMs: 1000, disabled: true });
    expect(next.escalation!.baseBlockMs).toBe(5000);
    expect(next.anomaly!.challengeThreshold).toBe(3);
    expect(warnings).toEqual(
      expect.arrayContaining([
        "rateLimits.no-such-limit: unknown rate limit id",
        "rateLimits.bot-command.windowMs: must be a positive integer",
        "escalation.nonsense: unknown setting",
        "anomaly.challengeThreshold: must be a positive integer",
      ])
    );
  });

  it("reads overrides from a file and inline env, inline winning", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abuse-")), "policy.json");
    fs.writeFileSync(file, JSON.stringify({ rateLimits: { "bot-command": { maxRequests: 7, windowMs: 2000 } } }));

    const { policy: next, warnings } = resolveAbusePolicy(policy(), {
      ABUSE_POLICY_FILE: file,
      ABUSE_POLICY_OVERRIDES: '{"rateLimits":{"bot-command":{"maxRequests":9}}}',
    });
    expect(next.rateLimits![0]).toMatchObject({ maxRequests: 9, windowMs: 2000 });
    expect(warnings).toEqual([]);

    expect(resolveAbusePolicy(policy(), { ABUSE_POLICY_OVERRIDES: "{oops" }).warnings).toEqual([
      "ABUSE_POLICY_OVERRIDES: invalid JSON",
    ]);
  });
});

describe("ExecutionGate", () => {
  const deferred = () => {
    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("throttles callers before invoking the provider", async () => {
    const abuse = new AbusePreventionService({
      rateLimits: [{ id: "provider-call", surfaces: ["provider"], maxRequests: 1, windowMs: 60_000, keyBy: ["userId"] }],
    });
    const gate = new ExecutionGate({ name: "test", maxConcurrent: 5, maxQueued: 5, queueTimeoutMs: 1000, abuse });
    const provider = jest.fn().mockResolvedValue("ok");

    await expect(gate.run({ userId: "u1" }, provider)).resolves.toBe("ok");
    await expect(gate.run({ userId: "u1" }, provider)).rejects.toMatchObject({ reason: "throttled" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(gate.getStats().rejected.throttled).toBe(1);
  });

  it("bounds concurrency and sheds load when the queue is full", async () => {
    const gate = new ExecutionGate({ name: "test", maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 1000 });
    const first = deferred();
    const running = gate.run({}, () => first.promise);
    const queued = gate.run({}, async () => "second");

    await expect(gate.run({}, async () => "third")).rejects.toMatchObject({ reason: "queue_full" });
    expect(gate.getStats()).toMatchObject({ active: 1, queued: 1 });

    first.resolve("first");
    await expect(running).resolves.toBe("first");
    await expect(queued).resolves.toBe("second");
    expect(gate.getStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("times out queued callers", async () => {
    const gate = new ExecutionGate({ name: "test", maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 10 });
    const first = deferred();
    const running = gate.run({}, () => first.promise);
    await expect(gate.run({}, async () => "late")).rejects.toMatchObject({ reason: "queue_timeout" });
    first.resolve("done");
    await running;
  });

  it("opens the circuit on provider failures but ignores caller errors", async () => {
    const gate = new ExecutionGate({
      name: "test",
      maxConcurrent: 5,
      maxQueued: 5,
      queueTimeoutMs: 1000,
      circuit: { failureThreshold: 2, recoveryTimeout: 60_000 },
      isFailure: (e) => (e as { statusCode?: number }).statusCode !== 404,
    });
    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    for (let i = 0; i < 5; i++) {
      await expect(gate.run({}, () => Promise.reject(notFound))).rejects.toBe(notFound);
    }
    expect(gate.getStats().circuitState).toBe("CLOSED");

    const outage = new Error("502");
    await expect(gate.run({}, () => Promise.reject(outage))).rejects.toBe(outage);
    await expect(gate.run({}, () => Promise.reject(outage))).rejects.toBe(outage);

    const provider = jest.fn();
    const error = (await gate.run({}, provider).catch((e) => e)) as ExecutionGateRejectedError;
    expect(error).toBeInstanceOf(ExecutionGateRejectedError);
    expect(error.reason).toBe("circuit_open");
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("createAbusePreventionMiddleware", () => {
  const run = async (middleware: ReturnType<typeof createAbusePreventionMiddleware>, body: object) => {
    const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" }, body, method: "POST", path: "/webhook" } as unknown as Request;
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await middleware(req, res as unknown as Response, next);
    return { res, next };
  };

  it("evaluates the configured surface with a custom subject and sets Retry-After", async () => {
    const service = new AbusePreventionService(policy());
    const evaluate = jest.spyOn(service, "evaluate");
    const middleware = createAbusePreventionMiddleware("webhook.telegram", service, {
      surface: "bot",
      subject: (req) => ({ userId: `telegram:${req.body.from}` }),
    });

    await run(middleware, { from: 42 });
    await run(middleware, { from: 42 });
    const { res, next } = await run(middleware, { from: 42 });

    expect(evaluate.mock.calls[0][0]).toMatchObject({ surface: "bot", subject: { userId: "telegram:42", ipAddress: "10.0.0.1" } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "1");
  });
});

describe("JobQueueService abuse guard", () => {
  it("rejects user jobs denied by the guard and lets system jobs through", async () => {
    const save = jest.fn(async (job) => ({ ...job, id: "job-1" }));
    const repo = { create: (x: object) => x, save };
    const dataSource = { getRepository: () => repo } as never;
    const guard = jest.fn().mockResolvedValue({ allowed: false, decision: "throttle", policyId: "job-enqueue" });
    const queue = new JobQueueService(dataSource, guard);

    await expect(queue.enqueue({ queue: "q", jobType: "swap", payload: {}, userId: "u1" })).rejects.toBeInstanceOf(
      JobThrottledError
    );
    expect(save).not.toHaveBeenCalled();

    await queue.enqueue({ queue: "q", jobType: "cleanup", payload: {} });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("AbuseTelemetry", () => {
  it("buffers recent events and audits escalations", async () => {
    const logEvent = jest.fn().mockResolvedValue(undefined);
    const telemetry = new AbuseTelemetry(2, async () => ({ logEvent }));
    const base = { surface: "bot" as const, action: "swap", subjectKey: "user:u1", at: 1 };

    telemetry.record({ ...base, type: "throttled" });
    telemetry.record({ ...base, type: "throttled", at: 2 });
    telemetry.record({ ...base, type: "escalated", at: 3, level: 1 });
    await new Promise((r) => setImmediate(r));

    expect(telemetry.getRecent().map((e) => e.at)).toEqual([3, 2]);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0]).toMatchObject({ action: PolicyAction.ABUSE_ESCALATED, actor: { userId: "u1" } });
  });
});
