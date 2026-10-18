import { Channel } from "./channelPolicy";
import { OPERATION_CATALOG, OperationPolicy, ROLE_GRANTS } from "./operationCatalog";
import { PRIVILEGE_GRAPH_VERSION, PrivilegeEdge, PrivilegeGraph, validateGraph } from "./privilegeGraph";

/**
 * Builds the privilege graph from the operation catalog. Resources are
 * channel-scoped ("swap:execute@bot") so the committed graph changes — and CI
 * flags it — whenever a role gains an operation *or* an operation becomes
 * reachable from a new channel.
 */

export function channelResource(operation: string, channel: Channel): string {
  return `${operation}@${channel}`;
}

function grantMatches(grant: string, operation: string): boolean {
  return grant.endsWith(":*") ? operation.startsWith(grant.slice(0, -1)) : grant === operation;
}

export function generatePrivilegeGraph(
  catalog: readonly OperationPolicy[] = OPERATION_CATALOG,
  grants: Readonly<Record<string, readonly string[]>> = ROLE_GRANTS
): PrivilegeGraph {
  const principals = Object.keys(grants).map((role) => `role:${role}`);
  const resources: string[] = [];
  const edges: PrivilegeEdge[] = [];
  const checks: PrivilegeGraph["checks"] = [];

  for (const policy of catalog) {
    for (const channel of policy.channels) {
      const resource = channelResource(policy.operation, channel);
      resources.push(resource);
      checks.push({ id: `check:${resource}`, resource });
      for (const [role, roleGrants] of Object.entries(grants)) {
        if (roleGrants.some((g) => grantMatches(g, policy.operation))) {
          edges.push({ kind: "grant", from: `role:${role}`, to: resource });
        }
      }
    }
  }

  const graph: PrivilegeGraph = { version: PRIVILEGE_GRAPH_VERSION, principals, resources, edges, checks };
  validateGraph(graph);
  return graph;
}
