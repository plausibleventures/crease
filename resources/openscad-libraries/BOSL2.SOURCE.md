# BOSL2 (vendored)

- Upstream: https://github.com/BelfrySCAD/BOSL2 (official repo)
- Release tag: v2.0.766 (published 2026-10-04), tag commit e173fa0ae45f9e2082e0d8c0382dae98621b7c20
- Tarball: https://github.com/BelfrySCAD/BOSL2/archive/refs/tags/v2.0.766.tar.gz
  sha256 abc156f23ade68a26f6e49ba86b9fd829dd39407bec29cbc7f6773d746b248ba; `git get-tar-commit-id` matched the tag commit.
- Fetched: 2026-10-06
- License: BSD-2-Clause (BOSL2/LICENSE, kept verbatim)
- Vendored subset: the 56 top-level `*.scad` library files plus LICENSE and README.md. Not vendored: tests/,
  examples/, tutorials/, images/, scripts/, resources/ (docs tooling), contributor docs. No library file
  includes anything outside the top level.
- Unmodified. Installed at server startup into `<STUDIO_HOME>/libraries/BOSL2` (server/cad/libraries.ts) and put on
  `OPENSCADPATH` for every OpenSCAD run.
- To upgrade: download a newer tag tarball from the official repo, verify the commit id, replace the files, update this note.
