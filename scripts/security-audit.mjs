#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const serverManifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const checks = [];

function check(condition, label) {
  if (!condition) throw new Error(`SECURITY AUDIT FAILED: ${label}`);
  checks.push(label);
}

function readFiles(paths, prefix = "") {
  return new Map(paths.map((path) => [path, readFileSync(join(root, prefix, path), "utf8")]));
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

const sourceFiles = ["auth.ts", "config.ts", "index.ts", "server.ts", "types.ts", "whoop.ts"];
const runtimeFiles = ["auth.js", "config.js", "index.js", "server.js", "types.js", "whoop.js"];
const declarationFiles = ["auth.d.ts", "config.d.ts", "index.d.ts", "server.d.ts", "types.d.ts", "whoop.d.ts"];
const sourceCheckout = existsSync(join(root, "src", "config.ts")) && existsSync(join(root, "package-lock.json"));

if (sourceCheckout) {
  const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
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
}

const approvedUrls = new Set([
  "https://api.prod.whoop.com/developer/v2",
  "https://api.prod.whoop.com/oauth/oauth2/auth",
  "https://api.prod.whoop.com/oauth/oauth2/token",
]);

function auditProgram(files, label) {
  const program = [...files.values()].join("\n");
  const urls = new Set(program.match(/https:\/\/[^"'`\s)]+/g) ?? []);
  check(
    [...urls].every((url) => approvedUrls.has(url)),
    `${label} outbound URL allowlist (${[...urls].sort().join(", ")})`,
  );
  check(!/\b(?:eval|Function)\s*\(/.test(program), `${label} contains no dynamic code evaluation`);
  check(!/\b(?:exec|execFile|fork)\s*\(/.test(program), `${label} contains no shell or arbitrary command execution APIs`);
  check(
    (program.match(/\bspawn\s*\(/g) ?? []).length === 1 &&
      files.get(label === "source" ? "auth.ts" : "auth.js")?.includes("[\"open\", [url]]") &&
      files.get(label === "source" ? "auth.ts" : "auth.js")?.includes("[\"cmd\", [\"/c\", \"start\", \"\", url]]") &&
      files.get(label === "source" ? "auth.ts" : "auth.js")?.includes("[\"xdg-open\", [url]]") &&
      files.get(label === "source" ? "auth.ts" : "auth.js")?.includes("shell: false"),
    `${label} sole child process call is a shell-disabled browser opener with fixed commands`,
  );
  check(
    !/read:(?:profile)|write:|delete:|update:|create:/i.test(program),
    `${label} OAuth and API surface contains no identity or write scope`,
  );
  check(
    (program.match(/method:\s*"POST"/g) ?? []).length === 2,
    `${label} POST surface is restricted to two OAuth token paths`,
  );
  check(
    program.includes("O_NOFOLLOW") &&
      program.includes("O_EXCL") &&
      program.includes("handle.sync()"),
    `${label} credential writes use no-follow, exclusive creation, and fsync`,
  );
  check(
    program.includes("credential persistence is disabled on native Windows") &&
      program.includes("pathSegments") &&
      program.includes("lease-v1:") &&
      !program.includes("process.kill"),
    `${label} fails closed on Windows, validates ancestors, and uses PID-independent lock leases`,
  );
  check(
    program.includes("timingSafeEqual") && program.includes("randomBytes(32)"),
    `${label} OAuth callbacks use 256-bit state and constant-time comparison`,
  );

  const server = files.get(label === "source" ? "server.ts" : "server.js") ?? "";
  check(
    (server.match(/annotations:\s*readOnlyAnnotations/g) ?? []).length === 5,
    `${label} has exactly five health tools sharing security annotations`,
  );
  check(
    server.includes("readOnlyHint: true") &&
      server.includes("destructiveHint: false") &&
      server.includes("idempotentHint: true") &&
      server.includes("openWorldHint: true"),
    `${label} annotations are read-only, non-destructive, and idempotent`,
  );
}

if (sourceCheckout) {
  auditProgram(readFiles(sourceFiles, "src"), "source");
}

for (const path of [...runtimeFiles, ...declarationFiles]) {
  check(existsSync(join(root, "dist", path)), `compiled artifact exists: dist/${path}`);
}
const localRuntime = readFiles(runtimeFiles, "dist");
auditProgram(localRuntime, "compiled runtime");

const packArguments = ["pack", "--ignore-scripts", "--json"];
const npmExecPath = process.env.npm_execpath;
const packOutput = execFileSync(
  npmExecPath ? process.execPath : "npm",
  npmExecPath ? [npmExecPath, ...packArguments] : packArguments,
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
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
    ...runtimeFiles.map((path) => `package/dist/${path}`),
    ...declarationFiles.map((path) => `package/dist/${path}`),
  ]);
  check(
    listing.length === allowedExact.size && listing.every((path) => allowedExact.has(path)),
    "npm tarball exactly matches the documented file allowlist",
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
  ];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const packedText = new Map();
  for (const path of listing) {
    const contents = execFileSync("tar", ["-xOf", tarballPath, path]);
    if (contents.includes(0)) continue;
    let text;
    try {
      text = decoder.decode(contents);
    } catch {
      throw new Error(`SECURITY AUDIT FAILED: non-UTF-8 text artifact ${path}`);
    }
    packedText.set(path, text);
    for (const pattern of secretPatterns) {
      pattern.lastIndex = 0;
      check(!pattern.test(text), `no secret/private-path pattern in ${path}`);
    }
    const lowerText = text.toLowerCase();
    const discordWebhookFragments = ["discord", "discordapp"].map(
      (host) => `${host}.com/api/${"webhooks"}/`,
    );
    check(
      discordWebhookFragments.every((fragment) => !lowerText.includes(fragment)),
      `no Discord webhook URL in ${path}`,
    );
  }

  const packedRuntime = new Map(
    runtimeFiles.map((path) => [path, packedText.get(`package/dist/${path}`)]),
  );
  auditProgram(packedRuntime, "packed runtime");
  for (const path of runtimeFiles) {
    check(
      packedRuntime.get(path) === localRuntime.get(path),
      `packed runtime is byte-identical to audited dist/${path}`,
    );
  }

  const packedManifest = JSON.parse(packedText.get("package/package.json"));
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

console.log(`Security audit passed: ${checks.length} reproducible checks${sourceCheckout ? " from source and shipped runtime" : " against the shipped runtime"}`);
