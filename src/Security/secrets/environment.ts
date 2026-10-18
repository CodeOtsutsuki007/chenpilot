/**
 * Deployment environment used to separate local, staging and production
 * secrets. APP_ENV (or DEPLOY_ENV) wins over NODE_ENV so a staging deploy can
 * run with NODE_ENV=production and still be treated as staging.
 */

export type DeploymentEnvironment = "local" | "staging" | "production";

const ALIASES: Record<string, DeploymentEnvironment> = {
  local: "local",
  dev: "local",
  development: "local",
  test: "local",
  staging: "staging",
  stage: "staging",
  preview: "staging",
  production: "production",
  prod: "production",
};

export function resolveDeploymentEnvironment(env: NodeJS.ProcessEnv = process.env): DeploymentEnvironment {
  const explicit = (env.APP_ENV ?? env.DEPLOY_ENV)?.trim().toLowerCase();
  if (explicit) {
    const resolved = ALIASES[explicit];
    if (!resolved) throw new Error(`Unknown APP_ENV "${explicit}". Use local, staging or production.`);
    return resolved;
  }
  return env.NODE_ENV === "production" ? "production" : "local";
}

/** Shared deployments (staging, production) never accept development shortcuts. */
export function isSharedEnvironment(environment: DeploymentEnvironment): boolean {
  return environment !== "local";
}
