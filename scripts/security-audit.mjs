#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const serverManifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const checks = [];

function check(condition, label) {
  if (!condition) throw new Error(`SECURITY AUDIT FAILED: ${label}`);
  checks.push(label);
}

const lifecycleScripts = ["preinstall", "install", "postinstall", "prepare"];
check(
  lifecycleScripts.every((name) => !(name in (packageJson.scripts ?? {}))),
  "package defines no dependency-install lifecycle scripts",
);

const runtimeDependencies = Object.entries(packageJson.dependencies ?? {});
check(
  JSON.stringify(runtimeDependencies.map(([name]) => name).sort()) ===
    JSON.stringify(["@modelcontextprotocol/sdk", "zod"]),
  "runtime dependency allowlist contains only MCP SDK and Zod",
);
check(
  [...runtimeDependencies, ...Object.entries(packageJson.devDependencies ?? {})].every(([, version]) =>
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version)),
  ),
  "all direct dependencies use exact versions",
);
check(packageLock.lockfileVersion >= 3, "modern package-lock format is required");
check(
  Object.entries(packageLock.packages ?? {})
    .filter(([path, metadata]) => path && metadata.dev !== true)
    .every(([, metadata]) => !metadata.hasInstallScript),
  "production dependency graph contains no install scripts",
);
check(
  Object.entries(packageLock.packages ?? {})
    .filter(([path]) => path)
    .every(([, metadata]) => typeof metadata.integrity === "string" && metadata.integrity.startsWith("sha512-")),
  "all locked dependency artifacts have SHA-512 integrity values",
);
check(
  packageJson.repository?.url === "git+https://github.com/Yadheedhya06/mcp-server-whoop.git",
  "package repository identity is fixed",
);
check(
  packageJson.version === serverManifest.version &&
    serverManifest.packages?.length === 1 &&
    serverManifest.packages[0]?.version === packageJson.version &&
    serverManifest.packages[0]?.identifier === packageJson.name,
  "npm and MCP Registry manifests identify the same package version",
);

const sourceFiles = [
  "src/auth.ts",
  "src/config.ts",
  "src/index.ts",
  "src/server.ts",
  "src/types.ts",
  "src/whoop.ts",
];
const sourceByFile = new Map(
  sourceFiles.map((path) => [path, readFileSync(join(root, path), "utf8")]),
);
const source = [...sourceByFile.values()].join("\n");
const sourceUrls = new Set(source.match(/https:\/\/[^"'`\s)]+/g) ?? []);
const approvedUrls = new Set([
  "https://api.prod.whoop.com/developer/v2",
  "https://api.prod.whoop.com/oauth/oauth2/auth",
  "https://api.prod.whoop.com/oauth/oauth2/token",
]);
check(
  [...sourceUrls].every((url) => approvedUrls.has(url)),
  `outbound source URL allowlist (${[...sourceUrls].sort().join(", ")})`,
);
check(!/\b(?:eval|Function)\s*\(/.test(source), "no dynamic code evaluation");
check(!/\b(?:exec|execFile|fork)\s*\(/.test(source), "no shell or arbitrary command execution APIs");
check(
  (source.match(/\bspawn\s*\(/g) ?? []).length === 1 &&
    sourceByFile.get("src/auth.ts")?.includes("[\"open\", [url]]") &&
    sourceByFile.get("src/auth.ts")?.includes("[\"cmd\", [\"/c\", \"start\", \"\", url]]") &&
    sourceByFile.get("src/auth.ts")?.includes("[\"xdg-open\", [url]]") &&
    sourceByFile.get("src/auth.ts")?.includes("shell: false"),
  "the sole child process call is a shell-disabled browser opener with a fixed command allowlist",
);
check(
  !/read:(?:profile)|write:|delete:|update:|create:/i.test(source),
  "OAuth and API surface contains no identity or write scope",
);
check(
  (source.match(/method:\s*"POST"/g) ?? []).length === 2 &&
    sourceByFile.get("src/auth.ts")?.includes("fetch(TOKEN_URL, {") &&
    sourceByFile.get("src/whoop.ts")?.includes("this.fetchImpl(this.tokenUrl, {"),
  "POST is restricted to the two OAuth token-exchange paths",
);
check(
  source.includes("O_NOFOLLOW") && source.includes("O_EXCL") && source.includes("handle.sync()"),
  "credential writes use no-follow, exclusive creation, and fsync primitives",
);
check(
  sourceByFile.get("src/config.ts")?.includes("metadata.uid !== currentUid") &&
    sourceByFile.get("src/config.ts")?.includes("metadata.nlink !== 1") &&
    sourceByFile.get("src/config.ts")?.includes("metadata.ino !== pathMetadata.ino"),
  "credential reads enforce current-user ownership and reject links or file swaps during validation",
);
check(
  source.includes("timingSafeEqual") && source.includes("randomBytes(32)"),
  "OAuth callbacks use 256-bit state and constant-time state comparison",
);

const serverSource = sourceByFile.get("src/server.ts");
check(
  (serverSource.match(/annotations: readOnlyAnnotations/g) ?? []).length === 5,
  "all five health tools use the shared security annotation set",
);
check(
  serverSource.includes("readOnlyHint: true") &&
    serverSource.includes("destructiveHint: false") &&
    serverSource.includes("idempotentHint: true") &&
    serverSource.includes("openWorldHint: true"),
  "security annotations declare read-only, non-destructive, idempotent WHOOP access",
);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packOutput = execFileSync(npm, ["pack", "--ignore-scripts", "--json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const packed = JSON.parse(packOutput)[0];
const tarballPath = join(root, packed.filename);

try {
  const listing = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  const verboseListing = execFileSync("tar", ["-tvzf", tarballPath], { encoding: "utf8" });

  const allowedExact = new Set([
    "package/CHANGELOG.md",
    "package/LICENSE",
    "package/README.md",
    "package/SECURITY-EVIDENCE.md",
    "package/SECURITY.md",
    "package/package.json",
    "package/scripts/security-audit.mjs",
    "package/server.json",
  ]);
  check(
    listing.every((path) => path.startsWith("package/dist/") || allowedExact.has(path)),
    "npm tarball contains only the documented runtime allowlist",
  );
  check(
    listing.every((path) => path.startsWith("package/") && !path.split("/").includes("..")),
    "npm tarball contains no absolute or traversal paths",
  );
  check(
    !verboseListing.split("\n").some((line) => /^[lh]/.test(line)),
    "npm tarball contains no hard links or symbolic links",
  );
  check(
    listing.every((path) => !/(^|\/)(?:\.env|node_modules|test|src|\.git|credentials\.json)(?:\/|$)/.test(path)),
    "npm tarball excludes credentials, tests, source, VCS data, and node_modules",
  );

  const secretPatterns = [
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\bnpm_[A-Za-z0-9]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    /\/opt\/data\//g,
    /(?:[A-Za-z]:\\Users\\|\/home\/)[^\s"']+/g,
    /discord(?:app)?\.com\/api\/webhooks\//gi,
  ];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const path of listing) {
    const contents = execFileSync("tar", ["-xOf", tarballPath, path]);
    if (contents.includes(0)) continue;
    let text;
    try {
      text = decoder.decode(contents);
    } catch {
      throw new Error(`SECURITY AUDIT FAILED: non-UTF-8 text artifact ${path}`);
    }
    for (const pattern of secretPatterns) {
      pattern.lastIndex = 0;
      check(!pattern.test(text), `no secret/private-path pattern in ${path}`);
    }
  }

  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], { encoding: "utf8" }),
  );
  check(
    packedManifest.name === packageJson.name && packedManifest.version === packageJson.version,
    "packed npm identity matches the audited source manifest",
  );
  check(
    packedManifest.bin?.[packageJson.name] === "dist/index.js",
    "packed executable points only to the compiled MCP entry point",
  );
  check(Number(packed.size) < 500_000, "compressed npm artifact stays below 500 KB");
  check(Number(packed.unpackedSize) < 1_500_000, "unpacked npm artifact stays below 1.5 MB");
  check(Number(packed.entryCount) === listing.length, "npm pack manifest matches tarball listing");
} finally {
  rmSync(tarballPath, { force: true });
}

console.log(`Security audit passed: ${checks.length} reproducible checks`);
