/**
 * Generates docs/security/privilege-graph.json from the operation catalog.
 *
 *   npx ts-node --transpile-only scripts/generatePrivilegeGraph.ts          # write
 *   npx ts-node --transpile-only scripts/generatePrivilegeGraph.ts --check  # CI: fail on drift
 *
 * In --check mode, any difference between the committed graph and the one
 * generated from code fails the build and lists newly added privilege edges,
 * so new authority is always reviewed in the PR that introduces it.
 */
import fs from "fs";
import path from "path";
import { generatePrivilegeGraph } from "../src/Security/authorization/graphGenerator";
import {
  newPrivilegeEdges,
  PrivilegeGraph,
  serializeGraph,
  unreachablePolicyChecks,
} from "../src/Security/authorization/privilegeGraph";

export const GRAPH_PATH = path.resolve(__dirname, "..", "docs", "security", "privilege-graph.json");

function main(): void {
  const check = process.argv.includes("--check");
  const graph = generatePrivilegeGraph();
  const serialized = serializeGraph(graph);

  const unreachable = unreachablePolicyChecks(graph);
  if (unreachable.length) {
    console.error("Policy checks guard resources no principal can reach:");
    unreachable.forEach((c) => console.error(`  - ${c.id}`));
    process.exit(1);
  }

  if (!check) {
    fs.mkdirSync(path.dirname(GRAPH_PATH), { recursive: true });
    fs.writeFileSync(GRAPH_PATH, serialized);
    console.log(`Wrote ${path.relative(process.cwd(), GRAPH_PATH)} (${graph.edges.length} edges)`);
    return;
  }

  if (!fs.existsSync(GRAPH_PATH)) {
    console.error(`${GRAPH_PATH} is missing. Run: npm run authz:graph`);
    process.exit(1);
  }

  const committedText = fs.readFileSync(GRAPH_PATH, "utf8");
  if (committedText === serialized) {
    console.log(`Privilege graph is up to date (${graph.edges.length} edges).`);
    return;
  }

  const committed = JSON.parse(committedText) as PrivilegeGraph;
  const added = newPrivilegeEdges(committed, graph);
  const removed = newPrivilegeEdges(graph, committed);
  console.error("Privilege graph is out of date. Run `npm run authz:graph` and commit the result.");
  if (added.length) {
    console.error("New privilege edges (require security review):");
    added.forEach((e) => console.error(`  + ${e.kind}: ${e.from} -> ${e.to}`));
  }
  if (removed.length) {
    console.error("Removed privilege edges:");
    removed.forEach((e) => console.error(`  - ${e.kind}: ${e.from} -> ${e.to}`));
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}
