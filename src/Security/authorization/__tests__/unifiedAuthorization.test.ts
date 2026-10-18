import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { baseDecision, Channel } from "../channelPolicy";
import {
  CATALOG_CHANNEL_POLICIES,
  CHANNELS,
  computePolicyVersion,
  deriveChannelPolicies,
  OPERATION_CATALOG,
  OperationPolicy,
  POLICY_VERSION,
  principalForRole,
  ROLE_GRANTS,
} from "../operationCatalog";
import { isNarrowingClaim, UnifiedAuthorizer } from "../unifiedAuthorizer";
import {
  authorizeJobOperation,
  captureJobAuthContext,
  parseClaimedChannel,
  requireOperation,
} from "../channelAdapters";
import { channelResource, generatePrivilegeGraph } from "../graphGenerator";
import { newPrivilegeEdges, serializeGraph, unreachablePolicyChecks } from "../privilegeGraph";
import { createApproval } from "../../../transactions/approvalDependencies";
import { PolicyAction } from "../../../AuditLog/auditEvent.types";
import { JobWorker } from "../../../jobs/jobWorker";
import { authorizeBotCommand } from "../../../../packages/bot/src/permissions/unifiedPolicy";

const ROLES = Object.keys(ROLE_GRANTS);
const authorizer = new UnifiedAuthorizer();

/** What the request would look like arriving on `channel` (jobs carry their origin). */
function requestOn(channel: Channel, role: string, operation: string, originChannel: Exclude<Channel, "job"> = "http") {
  const principal = principalForRole(`${role}-1`, role);
  return channel === "job"
    ? { operation, channel, job: { originPrincipal: principal, originChannel } }
    : { operation, channel, principal };
}

describe("cross-channel policy fixtures", () => {
  // Every role × operation × channel combination is compared against the
  // channel-independent base decision. The only allowed difference between
  // channels is the catalog's declared channel list.
  for (const role of ROLES) {
    for (const op of OPERATION_CATALOG) {
      it(`${role} → ${op.operation} is decided identically on every channel`, () => {
        const base = baseDecision(principalForRole(`${role}-1`, role), op.operation);
        for (const channel of CHANNELS) {
          const result = authorizer.evaluate(requestOn(channel, role, op.operation));
          if (!base.allowed) {
            expect({ channel, reason: result.reason }).toEqual({ channel, reason: base.reason });
          } else if (op.channels.includes(channel) && (channel !== "job" || op.channels.includes("http"))) {
            expect({ channel, allowed: result.allowed }).toEqual({ channel, allowed: true });
          } else {
            expect({ channel, reason: result.reason }).toEqual({ channel, reason: "channel_restricted" });
          }
        }
      });
    }
  }

  it("jobs keep the restrictions of the channel they originated from", () => {
    // swap:execute is allowed on bot and job, funding:deploy is not allowed on bot.
    expect(authorizer.evaluate(requestOn("job", "user", "swap:execute", "bot")).allowed).toBe(true);
    expect(authorizer.evaluate(requestOn("job", "user", "funding:deploy", "bot")).reason).toBe("channel_restricted");
    expect(authorizer.evaluate({ operation: "swap:execute", channel: "job" }).reason).toBe("missing_origin");
  });

  it("fails closed on unknown operations and suspended principals", () => {
    expect(authorizer.evaluate(requestOn("http", "admin", "admin:everything-else")).reason).toBe("unknown_operation");
    const suspended = principalForRole("u1", "admin", true);
    for (const channel of ["http", "bot", "websocket"] as Channel[]) {
      expect(authorizer.evaluate({ operation: "agent:query", channel, principal: suspended }).reason).toBe("suspended");
    }
  });

  it("never lets the bot channel reach admin operations, even for admins", () => {
    for (const op of OPERATION_CATALOG.filter((o) => o.sideEffect === "admin")) {
      expect(authorizer.evaluate(requestOn("bot", "admin", op.operation)).allowed).toBe(false);
    }
  });
});

describe("channel mismatch detection", () => {
  const admin = principalForRole("a1", "admin");

  it("blocks claims that would broaden authority", () => {
    const result = authorizer.evaluate({ operation: "admin:security", channel: "bot", claimedChannel: "http", principal: admin });
    expect(result).toMatchObject({ allowed: false, reason: "channel_mismatch" });
    expect(authorizer.evaluate({ operation: "agent:query", channel: "http", claimedChannel: "job", principal: admin }).reason).toBe(
      "channel_mismatch"
    );
  });

  it("evaluates narrowing claims under the stricter channel", () => {
    expect(isNarrowingClaim("bot", "http")).toBe(true);
    expect(isNarrowingClaim("http", "bot")).toBe(false);
    const result = authorizer.evaluate({ operation: "admin:security", channel: "http", claimedChannel: "bot", principal: admin });
    expect(result.reason).toBe("channel_restricted");
    expect(authorizer.evaluate({ operation: "swap:execute", channel: "http", claimedChannel: "bot", principal: admin }).allowed).toBe(true);
  });

  it("maps client channel labels and treats unknown labels as mismatches", () => {
    expect(parseClaimedChannel("UI")).toBe("http");
    expect(parseClaimedChannel("telegram")).toBe("bot");
    expect(parseClaimedChannel(undefined)).toBeUndefined();
    expect(parseClaimedChannel("superuser")).toBe("job");
  });
});

describe("policy change propagation", () => {
  it("a catalog change reaches every channel and changes the policy version", () => {
    const catalog: OperationPolicy[] = OPERATION_CATALOG.map((p) =>
      p.operation === "swap:execute" ? { ...p, channels: ["http"] } : p
    );
    const changed = new UnifiedAuthorizer({
      policies: deriveChannelPolicies(catalog),
      policyVersion: computePolicyVersion(catalog),
    });

    expect(changed.getPolicyVersion()).not.toBe(POLICY_VERSION);
    expect(changed.evaluate(requestOn("http", "user", "swap:execute")).allowed).toBe(true);
    expect(changed.evaluate(requestOn("bot", "user", "swap:execute")).reason).toBe("channel_restricted");
    expect(changed.evaluate(requestOn("job", "user", "swap:execute")).reason).toBe("channel_restricted");
  });

  it("queued jobs are re-authorized with current grants and flag the old policy version", async () => {
    const stored = { ...captureJobAuthContext({ userId: "u1", role: "admin" }, "http"), policyVersion: "old-version" };

    const allowed = await authorizeJobOperation(stored, "swap:execute", "job-1", undefined, authorizer);
    expect(allowed).toMatchObject({ allowed: true, enqueuedPolicyVersion: "old-version", principalId: "u1" });

    // The user was suspended after enqueueing: the job must not run.
    const revoked = await authorizeJobOperation(stored, "swap:execute", "job-1", async () => ({ userId: "u1", role: "user", suspended: true }), authorizer);
    expect(revoked.reason).toBe("suspended");

    const deleted = await authorizeJobOperation(stored, "swap:execute", "job-1", async () => undefined, authorizer);
    expect(deleted.reason).toBe("missing_origin");
  });

  it("captured job contexts never store grants", () => {
    const stored = captureJobAuthContext({ userId: "u1", role: "moderator" }, "bot");
    expect(stored).toEqual({ originPrincipalId: "u1", originRole: "moderator", originChannel: "bot", policyVersion: POLICY_VERSION });
  });
});

describe("approval invalidation", () => {
  const deps = {
    assetMetadataVersion: "a1",
    issuerStatusVersion: "i1",
    routeVersion: "r1",
    feePolicyVersion: "f1",
    contractVersion: "c1",
  };
  const payload = { amount: "10" };
  const approval = createApproval(payload, deps);
  const principal = principalForRole("u1", "user");

  it("rejects approvals whose economic inputs changed, on every channel", () => {
    for (const channel of ["http", "bot"] as Channel[]) {
      const result = authorizer.evaluate({
        operation: "swap:execute",
        channel,
        principal,
        approval: { approval, payload, current: { ...deps, feePolicyVersion: "f2" } },
      });
      expect(result).toMatchObject({ allowed: false, reason: "approval_invalidated", detail: "Fees changed since you approved." });
    }
    expect(
      authorizer.evaluate({ operation: "swap:execute", channel: "http", principal, approval: { approval, payload, current: deps } }).allowed
    ).toBe(true);
  });
});

describe("audit trail", () => {
  it("audits denials with the reason and policy version, and skips allowed by default", async () => {
    const logEvent = jest.fn().mockResolvedValue(undefined);
    const audited = new UnifiedAuthorizer({ audit: { logEvent } });

    await audited.authorize(requestOn("http", "user", "agent:query"));
    expect(logEvent).not.toHaveBeenCalled();

    await audited.authorize({ ...requestOn("http", "user", "admin:users"), resource: "POST /api/admin" });
    expect(logEvent.mock.calls[0][0]).toMatchObject({
      action: PolicyAction.AUTHORIZATION_DECISION,
      success: false,
      actor: { userId: "user-1" },
      metadata: { reason: "not_granted", policyVersion: POLICY_VERSION, channel: "http", resource: "POST /api/admin" },
    });

    await audited.authorize({ operation: "agent:query", channel: "bot", claimedChannel: "http", principal: principalForRole("u", "user") });
    expect(logEvent.mock.calls[1][0].action).toBe(PolicyAction.CHANNEL_MISMATCH);
  });

  it("keeps the decision when the audit sink fails", async () => {
    const audited = new UnifiedAuthorizer({ audit: { logEvent: jest.fn().mockRejectedValue(new Error("db down")) } });
    await expect(audited.authorize(requestOn("http", "user", "admin:users"))).resolves.toMatchObject({ allowed: false });
  });
});

describe("requireOperation middleware", () => {
  const run = async (req: Partial<Request> & { botIdentity?: unknown }, operation = "admin:security") => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    const fullReq = { headers: {}, method: "GET", baseUrl: "/api/security", path: "/stats", ...req } as Request;
    await requireOperation(operation, authorizer)(fullReq, res as unknown as Response, next);
    return { res, next, req: fullReq };
  };

  it("allows granted operations and records the decision on the request", async () => {
    const { next, req } = await run({ user: { userId: "a1", role: "admin" } as never });
    expect(next).toHaveBeenCalled();
    expect(req.authorization).toMatchObject({ allowed: true, resource: "GET /api/security/stats" });
  });

  it("treats bot-identity requests as the bot channel", async () => {
    const { res, next } = await run({
      user: { userId: "a1", role: "admin" } as never,
      botIdentity: { userId: "a1", platform: "telegram", platformUserId: "1" } as never,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: "channel_restricted" });
  });

  it("returns 401 without a principal and 403 on a broadening channel claim", async () => {
    expect((await run({})).res.status).toHaveBeenCalledWith(401);
    const mismatch = await run({
      user: { userId: "u1", role: "user" } as never,
      botIdentity: { userId: "u1" } as never,
      headers: { "x-client-channel": "api" },
    }, "agent:query");
    expect(mismatch.res.json.mock.calls[0][0]).toMatchObject({ code: "channel_mismatch" });
  });
});

describe("job worker enforcement", () => {
  function workerWith(job: Record<string, unknown>, role: string | undefined) {
    const queueService = {
      getJob: jest.fn().mockResolvedValue({ ...job, status: "leased" }),
      deadLetterJob: jest.fn().mockResolvedValue(undefined),
      renewLease: jest.fn().mockResolvedValue(true),
      completeJob: jest.fn().mockResolvedValue(undefined),
    };
    const worker = new JobWorker(queueService as never, {
      workerId: "w1",
      queues: ["q"],
      resolveJobActor: async (userId) => (role ? { userId, role } : undefined),
    });
    const handle = jest.fn().mockResolvedValue({ outcome: "completed" });
    worker.registerHandler({ jobType: "swap.run", operation: "swap:execute", handle });
    return { worker, queueService, handle };
  }

  const run = (worker: JobWorker, job: Record<string, unknown>) =>
    (worker as unknown as { processJob(job: unknown, slot: number): Promise<void> }).processJob(job, 0);

  it("dead-letters jobs whose origin principal is no longer authorized", async () => {
    const job = { id: "j1", jobType: "swap.run", userId: "u1", attempts: 0, metadata: {} };
    const { worker, queueService, handle } = workerWith(job, undefined);
    await run(worker, job);
    expect(handle).not.toHaveBeenCalled();
    expect(queueService.deadLetterJob.mock.calls[0][2]).toMatch(/^Authorization denied: missing_origin/);
  });

  it("dead-letters jobs that originated on a channel the operation forbids", async () => {
    const job = {
      id: "j2",
      jobType: "swap.run",
      userId: "u1",
      attempts: 0,
      metadata: { authContext: captureJobAuthContext({ userId: "u1" }, "websocket") },
    };
    const { worker, queueService, handle } = workerWith(job, "user");
    await run(worker, job);
    expect(handle).not.toHaveBeenCalled();
    expect(queueService.deadLetterJob.mock.calls[0][2]).toMatch(/channel_restricted/);
  });

  it("runs authorized jobs", async () => {
    const job = { id: "j3", jobType: "swap.run", userId: "u1", attempts: 0, metadata: {} };
    const { worker, queueService, handle } = workerWith(job, "user");
    await run(worker, job);
    expect(queueService.deadLetterJob).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalled();
  });
});

describe("privilege graph", () => {
  const graph = generatePrivilegeGraph();

  it("matches the committed docs/security/privilege-graph.json (run `npm run authz:graph`)", () => {
    const committed = fs.readFileSync(path.resolve(__dirname, "../../../../docs/security/privilege-graph.json"), "utf8");
    expect(committed).toBe(serializeGraph(graph));
  });

  it("has a reachable check for every channel-scoped resource", () => {
    expect(unreachablePolicyChecks(graph)).toEqual([]);
    expect(graph.resources).toHaveLength(OPERATION_CATALOG.reduce((n, op) => n + op.channels.length, 0));
  });

  it("only grants edges the authorizer would allow", () => {
    for (const edge of graph.edges) {
      const role = edge.from.replace("role:", "");
      const [operation, channel] = edge.to.split("@") as [string, Channel];
      expect(CATALOG_CHANNEL_POLICIES[channel].denied).not.toContain(operation);
      expect(baseDecision(principalForRole("x", role), operation).allowed).toBe(true);
    }
  });

  it("surfaces new authority as new edges for review", () => {
    const next = generatePrivilegeGraph(OPERATION_CATALOG, { ...ROLE_GRANTS, user: [...ROLE_GRANTS.user, "audit:read"] });
    expect(newPrivilegeEdges(graph, next)).toEqual([
      { kind: "grant", from: "role:user", to: channelResource("audit:read", "http") },
    ]);
  });
});

describe("bot unified policy bridge", () => {
  it("maps commands to catalog operations and fails closed", async () => {
    const checker = jest.fn().mockResolvedValue({ success: true, data: { allowed: false, reason: "channel_restricted" } });
    expect(await authorizeBotCommand(checker, "/swap")).toMatchObject({ allowed: false, reason: "channel_restricted" });
    expect(checker).toHaveBeenCalledWith({ operation: "swap:execute", channel: "bot", resource: "bot:/swap" });

    expect(await authorizeBotCommand(jest.fn().mockRejectedValue(new Error("down")), "swap")).toEqual({
      allowed: false,
      reason: "policy_unavailable",
    });
    expect((await authorizeBotCommand(checker, "help")).allowed).toBe(true);
  });

  it("only maps to operations that exist in the catalog", async () => {
    const { COMMAND_OPERATIONS } = await import("../../../../packages/bot/src/permissions/unifiedPolicy");
    const known = new Set(OPERATION_CATALOG.map((o) => o.operation));
    for (const op of Object.values(COMMAND_OPERATIONS)) expect(known.has(op)).toBe(true);
  });
});
