// Copies the freshly built `pdf_renderer` binary out of cargo's target directory into
// `desktop/bin/`, which is what tauri.conf.json declares as a bundled resource.
//
// Why the indirection: tauri.conf.json used to point straight at `../target/release/
// pdf_renderer.exe`, which silently assumed cargo's target directory sits inside the repo. It no
// longer does — `.cargo/config.toml` redirects it to a local disk, because this repo lives on a
// network share and building there is punishingly slow. A hardcoded `../target/...` resource path
// would then keep bundling whatever stale binary was last left on the share, which is exactly the
// "stale pdf_renderer silently serves old behavior" trap called out in CLAUDE.md.
//
// Asking cargo where its target directory actually is keeps this correct no matter how (or
// whether) `build.target-dir` is configured, on any machine.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ -> src-frontend/ -> desktop/ -> repo root
const repoRoot = resolve(scriptDir, "..", "..", "..");
const exeName = process.platform === "win32" ? "pdf_renderer.exe" : "pdf_renderer";

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }),
);

const source = join(metadata.target_directory, "release", exeName);
const destDir = join(repoRoot, "desktop", "bin");
mkdirSync(destDir, { recursive: true });
copyFileSync(source, join(destDir, exeName));
console.log(`copied ${source} -> ${join(destDir, exeName)}`);
