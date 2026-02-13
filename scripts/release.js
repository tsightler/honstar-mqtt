#!/usr/bin/env node

/**
 * Release script — bumps version in package.json and config.yaml,
 * runs npm update, commits, tags, and pushes to origin.
 *
 * Usage: npm run release <major|minor|patch|x.y.z>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const cfgPath = path.join(root, "config.yaml");

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

console.log(`Bumping version: ${pkg.version} → ${newVersion} (${bumpType})`);

// Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`  Updated package.json`);

// Update config.yaml
let cfg = fs.readFileSync(cfgPath, "utf8");
cfg = cfg.replace(/^version:\s*".*"/m, `version: "${newVersion}"`);
fs.writeFileSync(cfgPath, cfg);
console.log(`  Updated config.yaml`);

// Run npm update
console.log(`  Running npm update...`);
execSync("npm update", { cwd: root, stdio: "inherit" });

// Git commit, tag, push
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

run(`git add package.json package-lock.json config.yaml`);
run(`git commit -m "Release v${newVersion}"`);
run(`git tag v${newVersion}`);
run(`git push origin main --tags`);

console.log(`\nReleased v${newVersion}`);
