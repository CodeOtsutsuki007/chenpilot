# Documentation Archival Policy

Implementation and delivery reports accumulate at the repository root as
issues close. They are useful evidence of what was delivered, but left in place
they bury the documents people actually need. This policy decides what stays,
what moves, and how moved reports stay reachable.

## Document classes

| Class             | Examples                                                                                                                                       | Where it lives                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Active guidance   | `README.md`, `CONTRIBUTING.md`, runbooks, design and integration guides, quick starts that describe current behaviour                          | Repository root or `docs/`, linked from [INDEX.md](../INDEX.md)     |
| Completed report  | `ISSUE_<n>_IMPLEMENTATION.md`, `ISSUE_<n>_DELIVERY_SUMMARY.md`, `ISSUE_<n>_README.md`, verification and delivery checklists for a single issue | `docs/archive/implementation-reports/<issue>-<slug>/` once archived |
| Generated output  | `docs/TOOLS.md` (`npm run gen:docs`), the INDEX.md documentation map (`npm run docs:index`)                                                    | Wherever the generator writes it; never edited by hand              |
| Local diagnostics | Terminal captures such as `_tsc.txt`                                                                                                           | `.artifacts/` (ignored); never committed                            |

## When a report is retained

Keep a report where it is when any of the following holds:

- its issue or pull request is still open;
- code, CI, or a maintained document depends on its location (for example a
  script reads it, or a runbook tells operators to open it);
- it is the only home of guidance that is still current. Move that guidance
  into an active document first, then archive the report.

## When a report is moved

Move a completed report into the archive when its issue is closed, its
implementation is merged, and none of the retention rules apply. Reports for
the same issue move together into one `<issue>-<slug>` folder so references
between them keep working.

Moving a report must not remove issue evidence or break links:

1. Use `git mv` so history follows the file (`git log --follow`).
2. Keep the file name and content. Only prepend the standard archive notice.
3. Add a row to the manifest in [docs/archive/README.md](archive/README.md):
   archived path, original path, issue, and date.
4. Update every maintained document that pointed at the original path to point
   at the archived path instead.
5. Run `npm run docs:index` so the archived report appears in the INDEX.md
   documentation map, then `npm run docs:check`.

Archived reports are never deleted. If a report is superseded, link the
replacement from its INDEX.md entry rather than removing the old report.

## When a report is linked from the index

- **Active guidance** gets a curated INDEX.md entry, written by hand.
- **Archived reports** are linked from the generated documentation map in
  INDEX.md. A curated entry may also link an archived report as its
  implementation evidence.
- **Generated output and local diagnostics** are not linked as evidence.

## Enforcement

`npm run docs:check` runs in CI (`.github/workflows/docs-checks.yml`) and
fails when:

- a file under `docs/archive/` has no manifest row, or a manifest row points at
  a missing file;
- a report still exists at its original path after being archived (a copy,
  not a move);
- a maintained document still references an original path;
- an archived report is not linked from INDEX.md.

## Applied so far

The policy was first applied to the three #858 in-transit bridge accounting
reports. The design document, `BRIDGE_ACCOUNTING_DESIGN.md`, and the
integration guide stay in place because they describe current behaviour. See
the [archive manifest](archive/README.md) for the full list.
