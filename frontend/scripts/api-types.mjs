// Generate src/api/schema.d.ts from the backend's committed OpenAPI snapshot.
//
//   npm run api:types   write the file
//   npm run api:check   fail if the committed file differs from what would be generated
//
// The snapshot (../backend/openapi.json) is produced by the backend's
// scripts/export_openapi.py; a backend test keeps it current. No server is needed here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = path.join(root, "../backend/openapi.json");
const target = path.join(root, "src/api/schema.d.ts");
const cli = path.join(root, "node_modules/openapi-typescript/bin/cli.js");
const check = process.argv.includes("--check");

const dir = mkdtempSync(path.join(tmpdir(), "blueprintiq-api-"));
try {
  const out = path.join(dir, "schema.d.ts");
  const run = spawnSync(process.execPath, [cli, snapshot, "-o", out, "--root-types"], {
    cwd: root,
    encoding: "utf8",
  });
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout);
    process.exit(1);
  }
  const generated = readFileSync(out, "utf8").replace(/\r\n/g, "\n");
  if (check) {
    let current = "";
    try {
      current = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
    } catch {
      // missing file counts as stale
    }
    if (current !== generated) {
      console.error("src/api/schema.d.ts is stale. Run `npm run api:types` and commit the result.");
      process.exit(1);
    }
    console.log("src/api/schema.d.ts is current.");
  } else {
    writeFileSync(target, generated);
    console.log("wrote src/api/schema.d.ts");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
