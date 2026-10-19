// Shared, dependency-free Markdown helpers for the repository documentation
// checks (link checker, index checker, archive checker). Everything here is
// deterministic: output order follows file order and line order.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const INLINE_LINK =
  /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEF = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const CODE_PATH = /`([\w./-]+\.(?:md|ts|js|mjs|cjs|json|ya?ml|sh|rs|toml))`/g;

/** Replace inline code spans with spaces so links inside them are ignored. */
function blankInlineCode(line) {
  return line.replace(/(`+)(?:(?!\1).)+\1/g, (m) => " ".repeat(m.length));
}

/**
 * Yield [lineNumber, text] for every line outside fenced code blocks.
 * Line numbers are 1-based.
 */
export function* proseLines(content) {
  const lines = content.split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(FENCE);
    if (match) {
      const marker = match[1];
      if (fence === null) {
        fence = marker;
        continue;
      }
      if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
        continue;
      }
    }
    if (fence === null) yield [i + 1, lines[i]];
  }
}

/** Extract Markdown link targets (inline, image, and reference definitions). */
export function extractLinks(content) {
  const links = [];
  for (const [line, raw] of proseLines(content)) {
    const text = blankInlineCode(raw);
    const def = text.match(REFERENCE_DEF);
    if (def) links.push({ line, target: unwrap(def[1]) });
    for (const m of text.matchAll(INLINE_LINK)) {
      links.push({ line, target: unwrap(m[1]) });
    }
  }
  return links;
}

/** Extract `path/to/file.ext` code-span references, the style used by INDEX.md. */
export function extractCodePathRefs(content) {
  const refs = [];
  for (const [line, raw] of proseLines(content)) {
    for (const m of raw.matchAll(CODE_PATH)) refs.push({ line, target: m[1] });
  }
  return refs;
}

/** Extract ATX headings with their level and normalized text. */
export function extractHeadings(content) {
  const headings = [];
  for (const [line, raw] of proseLines(content)) {
    const m = raw.match(HEADING);
    if (m) headings.push({ line, level: m[1].length, text: m[2].trim() });
  }
  return headings;
}

function unwrap(target) {
  return target.startsWith("<") && target.endsWith(">")
    ? target.slice(1, -1)
    : target;
}

/**
 * True when a link target points outside the repository working tree:
 * URLs with a scheme (http:, mailto:, ...), protocol-relative URLs, and
 * same-document anchors.
 */
export function isExternalOrAnchor(target) {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

/**
 * Resolve a local link target to a repository-relative POSIX path.
 * Fragments and query strings are dropped; a leading "/" means repo root,
 * matching how GitHub renders repository Markdown.
 */
export function resolveLocalTarget(sourceFile, target) {
  let clean = target.split("#")[0].split("?")[0];
  try {
    clean = decodeURI(clean);
  } catch {
    // Keep the raw target; the existence check will report it.
  }
  const base = clean.startsWith("/") ? "" : path.posix.dirname(sourceFile);
  return path.posix.normalize(path.posix.join(base, clean.replace(/^\/+/, "")));
}

/** Convert a small glob (`*`, `**`, `?`) to an anchored RegExp. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

/**
 * Tracked and new (untracked, not ignored) files matching a pathspec,
 * relative to `cwd`, sorted. Deleted-but-unstaged files are skipped.
 */
export function gitLsFiles(cwd, pathspecs) {
  const args = [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...pathspecs,
  ];
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && fs.existsSync(path.join(cwd, file)))
    .sort();
}

export function readConfig(root) {
  const file = path.join(root, "scripts/docs/docs-check.config.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function pathExists(root, relPath) {
  return (
    relPath !== ".." &&
    !relPath.startsWith("../") &&
    fs.existsSync(path.join(root, relPath))
  );
}
