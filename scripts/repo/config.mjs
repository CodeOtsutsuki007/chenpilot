// Shared loader for the repository inventory checks in scripts/repo/.

import fs from "node:fs";
import path from "node:path";

export function readRepoConfig(root) {
  const file = path.join(root, "scripts/repo/repo-check.config.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
