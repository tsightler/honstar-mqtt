#!/usr/bin/env node

/**
 * Release script — bumps version in package.json and config.yaml,
 * updates CHANGELOG.md from git commits, runs npm update, commits,
 * tags, and pushes to origin.
 *
 * Usage: npm run release <major|minor|patch|x.y.z>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const cfgPath = path.join(root, "config.yaml");
const changelogPath = path.join(root, "CHANGELOG.md");

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: npm run release <major|minor|patch|x.y.z>");
  process.exit(1);
}

// Read current version from package.json
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);

let newVersion;
if (arg === "major") newVersion = `${major + 1}.0.0`;
else if (arg === "minor") newVersion = `${major}.${minor + 1}.0`;
else if (arg === "patch") newVersion = `${major}.${minor}.${patch + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) newVersion = arg;
else {
  console.error(`Invalid argument: "${arg}" (use major, minor, patch, or x.y.z)`);
  process.exit(1);
}

console.log(`Bumping version: ${pkg.version} → ${newVersion}`);

// Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`  Updated package.json`);

// Update config.yaml
let cfg = fs.readFileSync(cfgPath, "utf8");
cfg = cfg.replace(/^version:\s*".*"/m, `version: "${newVersion}"`);
fs.writeFileSync(cfgPath, cfg);
console.log(`  Updated config.yaml`);

// Update CHANGELOG.md
updateChangelog(newVersion);

// Run npm update
console.log(`  Running npm update...`);
execSync("npm update", { cwd: root, stdio: "inherit" });

// Git commit, tag, push
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

run(`git add package.json package-lock.json config.yaml CHANGELOG.md`);
run(`git commit -m "Release v${newVersion}"`);
run(`git tag v${newVersion}`);
run(`git push origin main --tags`);

console.log(`\nReleased v${newVersion}`);

/**
 * Collects git commits since the last tag, categorizes them, and
 * prepends a new section to CHANGELOG.md.
 */
function updateChangelog(version) {
  // Find the latest tag to use as the base for the commit range
  let lastTag;
  try {
    lastTag = execSync("git describe --tags --abbrev=0", { cwd: root })
      .toString()
      .trim();
  } catch {
    lastTag = null;
  }

  // Get commit subjects since the last tag (or all commits if no tag)
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  let raw;
  try {
    raw = execSync(`git log ${range} --format=%s`, { cwd: root })
      .toString()
      .trim();
  } catch {
    raw = "";
  }

  if (!raw) {
    console.log("  No new commits for changelog");
    return;
  }

  // Filter out release/merge/meta commits
  const skipPattern = /^(Release |Merge |Update release|Update repository)/i;
  const commits = raw
    .split("\n")
    .filter((msg) => msg && !skipPattern.test(msg));

  if (commits.length === 0) {
    console.log("  No notable commits for changelog");
    return;
  }

  // Categorise commits by conventional-ish prefixes
  const added = [];
  const fixed = [];
  const changed = [];

  for (const msg of commits) {
    const lower = msg.toLowerCase();
    if (lower.startsWith("add ") || lower.startsWith("add:")) {
      added.push(msg);
    } else if (lower.startsWith("fix ") || lower.startsWith("fix:") || lower.startsWith("fix(")) {
      fixed.push(msg);
    } else {
      changed.push(msg);
    }
  }

  // Build the new changelog section
  const today = new Date().toISOString().slice(0, 10);
  let section = `## [${version}] - ${today}\n`;

  if (added.length) {
    section += `\n### Added\n`;
    for (const m of added) section += `- ${m}\n`;
  }
  if (changed.length) {
    section += `\n### Changed\n`;
    for (const m of changed) section += `- ${m}\n`;
  }
  if (fixed.length) {
    section += `\n### Fixed\n`;
    for (const m of fixed) section += `- ${m}\n`;
  }

  // Prepend to existing changelog (or create a new one)
  let existing = "";
  if (fs.existsSync(changelogPath)) {
    existing = fs.readFileSync(changelogPath, "utf8");
  }

  // Insert after the "# Changelog" header, or prepend if no header
  const header = "# Changelog";
  let updated;
  if (existing.startsWith(header)) {
    updated = `${header}\n\n${section}\n${existing.slice(header.length).replace(/^\n+/, "")}`;
  } else {
    updated = `${header}\n\n${section}\n${existing}`;
  }

  fs.writeFileSync(changelogPath, updated);
  console.log(`  Updated CHANGELOG.md`);
}
