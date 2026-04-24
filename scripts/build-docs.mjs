#!/usr/bin/env node
// Build the site into docs/ while preserving CNAME (and any user-pinned files).
// Usage: node scripts/build-docs.mjs
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");
const PRESERVE = new Set(["CNAME", ".nojekyll"]);

let cnameContents = null;
if (existsSync(join(DOCS, "CNAME"))) {
  cnameContents = readFileSync(join(DOCS, "CNAME"));
}

// Clean docs/ but preserve CNAME etc.
if (existsSync(DOCS)) {
  for (const entry of readdirSync(DOCS)) {
    if (PRESERVE.has(entry)) continue;
    const p = join(DOCS, entry);
    rmSync(p, { recursive: true, force: true });
  }
}

// Determine base path: prefer existing CNAME (custom domain => "/"), otherwise repo subpath.
let base = "/";
if (cnameContents) {
  base = "/";
} else if (process.env.VITE_BASE) {
  base = process.env.VITE_BASE;
} else {
  // Try to infer from git remote (e.g. github.com:user/repo.git -> /repo/)
  try {
    const remote = execSync("git config --get remote.origin.url", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const m = remote.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) base = `/${m[2]}/`;
  } catch {
    // no remote, keep "/"
  }
}

console.log(`[build-docs] base = ${base}`);
execSync(`VITE_BASE=${base} npx vite build`, { stdio: "inherit", env: { ...process.env, VITE_BASE: base } });

// Always write .nojekyll so GitHub Pages serves files starting with underscore
writeFileSync(join(DOCS, ".nojekyll"), "");

// Restore CNAME (defensive — vite has emptyOutDir:false but be safe).
if (cnameContents) {
  writeFileSync(join(DOCS, "CNAME"), cnameContents);
  console.log("[build-docs] CNAME preserved");
}

// Stage docs/ for commit (pre-commit hook usage)
try {
  execSync("git add docs", { stdio: "inherit" });
} catch {
  /* ignore */
}
