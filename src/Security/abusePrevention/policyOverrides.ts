import fs from "fs";
import { AbusePolicy, AnomalyPolicy, EscalationPolicy, RateLimitPolicy } from "./types";

/**
 * Operator-tunable abuse thresholds.
 *
 * Overrides are read from (later sources win):
 *   1. ABUSE_POLICY_FILE           — path to a JSON file
 *   2. ABUSE_POLICY_OVERRIDES      — inline JSON
 *
 * Shape:
 *   {
 *     "rateLimits": { "bot-command": { "maxRequests": 5, "windowMs": 60000, "disabled": false } },
 *     "escalation": { "violationThreshold": 5, "windowMs": 600000, "baseBlockMs": 60000, "maxBlockMs": 3600000 },
 *     "anomaly":    { "windowMs": 300000, "challengeThreshold": 5, "blockThreshold": 10 }
 *   }
 *
 * Invalid values are ignored and reported in `warnings` so a typo can never
 * disable protection or crash startup.
 */

type RateLimitOverride = Partial<Pick<RateLimitPolicy, "maxRequests" | "windowMs" | "disabled">>;

export interface AbusePolicyOverrides {
  rateLimits?: Record<string, RateLimitOverride>;
  escalation?: Partial<EscalationPolicy>;
  anomaly?: Partial<AnomalyPolicy>;
}

export interface OverrideResult {
  policy: AbusePolicy;
  warnings: string[];
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function mergeNumbers<T extends object>(
  base: T | undefined,
  override: Record<string, unknown> | undefined,
  section: string,
  warnings: string[]
): T | undefined {
  if (!override) return base;
  if (!base) {
    warnings.push(`${section}: no base policy to override`);
    return base;
  }
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (!(key in merged)) {
      warnings.push(`${section}.${key}: unknown setting`);
    } else if (!isPositiveInt(value)) {
      warnings.push(`${section}.${key}: must be a positive integer`);
    } else {
      merged[key] = value;
    }
  }
  return merged as T;
}

export function applyAbusePolicyOverrides(base: AbusePolicy, overrides: AbusePolicyOverrides): OverrideResult {
  const warnings: string[] = [];
  const known = new Set((base.rateLimits ?? []).map((r) => r.id));

  for (const id of Object.keys(overrides.rateLimits ?? {})) {
    if (!known.has(id)) warnings.push(`rateLimits.${id}: unknown rate limit id`);
  }

  const rateLimits = (base.rateLimits ?? []).map((limit) => {
    const override = overrides.rateLimits?.[limit.id];
    if (!override) return limit;
    const next = { ...limit };
    for (const key of ["maxRequests", "windowMs"] as const) {
      if (override[key] === undefined) continue;
      if (isPositiveInt(override[key])) next[key] = override[key] as number;
      else warnings.push(`rateLimits.${limit.id}.${key}: must be a positive integer`);
    }
    if (override.disabled !== undefined) {
      if (typeof override.disabled === "boolean") next.disabled = override.disabled;
      else warnings.push(`rateLimits.${limit.id}.disabled: must be a boolean`);
    }
    return next;
  });

  return {
    policy: {
      ...base,
      rateLimits,
      escalation: mergeNumbers(base.escalation, overrides.escalation as Record<string, unknown>, "escalation", warnings),
      anomaly: mergeNumbers(base.anomaly, overrides.anomaly as Record<string, unknown>, "anomaly", warnings),
    },
    warnings,
  };
}

function parseJson(source: string, label: string, warnings: string[]): AbusePolicyOverrides {
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AbusePolicyOverrides;
    warnings.push(`${label}: must be a JSON object`);
  } catch {
    warnings.push(`${label}: invalid JSON`);
  }
  return {};
}

/** Reads overrides from the environment; never throws. */
export function loadAbusePolicyOverrides(env: NodeJS.ProcessEnv = process.env): {
  overrides: AbusePolicyOverrides[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const overrides: AbusePolicyOverrides[] = [];

  const file = env.ABUSE_POLICY_FILE?.trim();
  if (file) {
    try {
      overrides.push(parseJson(fs.readFileSync(file, "utf8"), "ABUSE_POLICY_FILE", warnings));
    } catch {
      warnings.push(`ABUSE_POLICY_FILE: cannot read ${file}`);
    }
  }

  const inline = env.ABUSE_POLICY_OVERRIDES?.trim();
  if (inline) overrides.push(parseJson(inline, "ABUSE_POLICY_OVERRIDES", warnings));

  return { overrides, warnings };
}

export function resolveAbusePolicy(base: AbusePolicy, env: NodeJS.ProcessEnv = process.env): OverrideResult {
  const loaded = loadAbusePolicyOverrides(env);
  return loaded.overrides.reduce<OverrideResult>(
    (acc, override) => {
      const next = applyAbusePolicyOverrides(acc.policy, override);
      return { policy: next.policy, warnings: [...acc.warnings, ...next.warnings] };
    },
    { policy: base, warnings: loaded.warnings }
  );
}
