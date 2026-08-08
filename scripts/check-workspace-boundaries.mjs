import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const apiRoot = path.join(repositoryRoot, "apps/api");
const legacyRoot = path.join(repositoryRoot, "apps/legacy");
const webRoot = path.join(repositoryRoot, "apps/web");
const failures = [];
const defaultScriptNames = [
  "build",
  "check",
  "test",
  "start",
  "dev:node",
];
const webDefaultScriptNames = new Set(["build", "check", "test"]);
const allowedRootDevDependencies = new Set(["husky"]);

function relative(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function requireFile(absolutePath) {
  if (!fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    failures.push(`missing required file: ${relative(absolutePath)}`);
  }
}

function forbidPath(absolutePath, reason) {
  if (fs.existsSync(absolutePath))
    failures.push(`${relative(absolutePath)}: ${reason}`);
}

function readJson(absolutePath) {
  requireFile(absolutePath);
  if (!fs.existsSync(absolutePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    failures.push(`${relative(absolutePath)}: invalid JSON (${error.message})`);
    return {};
  }
}

function workspaceDependencyRoots(
  workspaceRoot,
  { pythonEnvironments = false, wrangler = false } = {},
) {
  const roots = new Set([path.join(workspaceRoot, "node_modules")]);
  if (wrangler) roots.add(path.join(workspaceRoot, ".wrangler"));
  if (!pythonEnvironments) return roots;
  roots.add(path.join(workspaceRoot, ".venv"));
  roots.add(path.join(workspaceRoot, "venv"));
  if (!fs.existsSync(workspaceRoot)) return roots;
  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith("_venv")) {
      roots.add(path.join(workspaceRoot, entry.name));
    }
  }
  return roots;
}

function filesUnder(directory, excludedDirectoryRoots = new Set()) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && excludedDirectoryRoots.has(absolute)) return [];
    return entry.isDirectory()
      ? filesUnder(absolute, excludedDirectoryRoots)
      : [absolute];
  });
}

function splitShellCommands(command) {
  const commands = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) commands.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (character === ";" || character === "|") {
      if (current.trim()) commands.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) commands.push(current.trim());
  return commands;
}

function shellTokens(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function pnpmInvocation(tokens) {
  const pnpmIndex = tokens.findIndex((token) =>
    /^(?:pnpm|pnpm\.cmd)$/.test(path.basename(token)),
  );
  if (pnpmIndex === -1) return null;

  const args = tokens.slice(pnpmIndex + 1);
  const filters = [];
  let directory = null;
  let recursive = false;
  let commandIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--recursive" || argument === "-r") {
      recursive = true;
      continue;
    }
    if (argument === "--filter" || argument === "-F") {
      filters.push(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (argument.startsWith("--filter=")) {
      filters.push(argument.slice("--filter=".length));
      continue;
    }
    if (argument.startsWith("-F=")) {
      filters.push(argument.slice("-F=".length));
      continue;
    }
    if (argument === "--dir" || argument === "-C") {
      directory = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument.startsWith("--dir=")) {
      directory = argument.slice("--dir=".length);
      continue;
    }
    if (argument.startsWith("-C=")) {
      directory = argument.slice("-C=".length);
      continue;
    }
    if (!argument.startsWith("-")) {
      commandIndex = index;
      break;
    }
  }
  if (commandIndex === -1)
    return { command: null, directory, filters, recursive, script: null };

  const command = args[commandIndex];
  const script =
    command === "run" || command === "run-script"
      ? (args[commandIndex + 1] ?? null)
      : !["exec", "install", "add", "remove", "update", "dlx"].includes(command)
        ? command
        : null;
  return { command, directory, filters, recursive, script };
}

function validateDefaultScripts(
  rootPackage,
  workspacePackages,
  targetFailures = failures,
) {
  const packageScripts = new Map([
    ["root", rootPackage.scripts ?? {}],
    ["@imsweb/api", workspacePackages.api?.scripts ?? {}],
    ["@imsweb/web", workspacePackages.web?.scripts ?? {}],
  ]);
  const allowedFilters = new Set(["@imsweb/api", "@imsweb/web"]);

  function inspectScript(packageName, scriptName, stack, evidence) {
    const key = `${packageName}:${scriptName}`;
    if (stack.includes(key)) {
      targetFailures.push(
        `package.json: default command alias cycle: ${[...stack, key].join(" -> ")}`,
      );
      return;
    }
    const script = packageScripts.get(packageName)?.[scriptName];
    if (typeof script !== "string" || !script.trim()) {
      targetFailures.push(
        `package.json: default command resolves to missing script ${key}`,
      );
      return;
    }
    if (
      /(?:^|[\s/])(?:apps\/legacy|@imsweb\/legacy|legacy:)(?:[\s/]|$)/i.test(
        script,
      )
    ) {
      targetFailures.push(
        `package.json: default command ${stack[0] ?? key} reaches legacy through ${key}`,
      );
    }

    for (const shellCommand of splitShellCommands(script)) {
      const invocation = pnpmInvocation(shellTokens(shellCommand));
      if (!invocation) continue;
      if (
        invocation.directory &&
        /(?:^|\/)apps\/legacy(?:\/|$)/i.test(invocation.directory)
      ) {
        targetFailures.push(
          `package.json: default command ${stack[0] ?? key} changes pnpm directory to legacy in ${key}`,
        );
        continue;
      }
      if (invocation.recursive) {
        targetFailures.push(
          `package.json: default command ${stack[0] ?? key} uses unbounded recursive pnpm execution in ${key}`,
        );
        continue;
      }
      if (invocation.filters.length) {
        const invalidFilters = invocation.filters.filter(
          (filter) => !allowedFilters.has(filter),
        );
        if (invalidFilters.length) {
          targetFailures.push(
            `package.json: default command ${stack[0] ?? key} has unsupported pnpm filter(s) in ${key}: ${invalidFilters.join(", ")}`,
          );
          continue;
        }
        for (const filter of new Set(invocation.filters)) {
          if (filter === "@imsweb/api") evidence.api = true;
          if (filter === "@imsweb/web") evidence.web = true;
          if (invocation.script) {
            inspectScript(filter, invocation.script, [...stack, key], evidence);
          }
        }
        continue;
      }
      if (invocation.script) {
        inspectScript(
          packageName,
          invocation.script,
          [...stack, key],
          evidence,
        );
      }
    }
  }

  for (const scriptName of defaultScriptNames) {
    if (!rootPackage.scripts?.[scriptName]) {
      targetFailures.push(
        `package.json: missing default API command ${scriptName}`,
      );
      continue;
    }
    const evidence = { api: false, web: false };
    inspectScript("root", scriptName, [], evidence);
    if (!evidence.api) {
      targetFailures.push(
        `package.json: default command ${scriptName} never resolves to @imsweb/api`,
      );
    }
    if (webDefaultScriptNames.has(scriptName) && !evidence.web) {
      targetFailures.push(
        `package.json: default command ${scriptName} never resolves to @imsweb/web`,
      );
    }
    if (!webDefaultScriptNames.has(scriptName) && evidence.web) {
      targetFailures.push(
        `package.json: default command ${scriptName} must remain API-only`,
      );
    }
  }
}

const rootPackage = readJson(path.join(repositoryRoot, "package.json"));
const apiPackage = readJson(path.join(apiRoot, "package.json"));
const webPackage = readJson(path.join(webRoot, "package.json"));

if (rootPackage.name !== "imsweb-monorepo" || rootPackage.private !== true) {
  failures.push(
    "package.json: root must be the private imsweb-monorepo orchestrator",
  );
}
for (const dependencyKind of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  const forbiddenDependencies = Object.keys(
    rootPackage[dependencyKind] ?? {},
  ).filter(
    (dependency) =>
      dependencyKind !== "devDependencies" ||
      !allowedRootDevDependencies.has(dependency),
  );
  if (forbiddenDependencies.length) {
    failures.push(
      `package.json: root aggregator must not declare ${dependencyKind}: ${forbiddenDependencies.join(", ")}`,
    );
  }
}
if (apiPackage.name !== "@imsweb/api" || apiPackage.private !== true) {
  failures.push("apps/api/package.json: expected private package @imsweb/api");
}
if (webPackage.name !== "@imsweb/web" || webPackage.private !== true) {
  failures.push("apps/web/package.json: expected private package @imsweb/web");
}

const workspace = fs.readFileSync(
  path.join(repositoryRoot, "pnpm-workspace.yaml"),
  "utf8",
);
for (const workspacePath of ["apps/api", "apps/web"]) {
  if (!workspace.includes(`- ${workspacePath}`)) {
    failures.push(`pnpm-workspace.yaml: missing ${workspacePath}`);
  }
}

for (const nestedRootMarker of [
  ".git",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]) {
  forbidPath(
    path.join(webRoot, nestedRootMarker),
    "web must use the repository root Git and pnpm workspace",
  );
}

const webAppRoot = path.join(webRoot, "app");
const webApiRoot = path.join(webAppRoot, "lib/api");
const webPagesRoot = path.join(webAppRoot, "pages");
forbidPath(
  path.join(webAppRoot, "features"),
  "web page implementations must follow the app/pages route hierarchy",
);
forbidPath(
  path.join(webAppRoot, "shared"),
  "web shared modules must live under app/lib",
);
for (const sourceFile of filesUnder(webAppRoot)) {
  if (!/\.tsx?$/.test(sourceFile)) continue;
  if (/\.(?:test|spec)\.tsx?$/.test(sourceFile)) {
    failures.push(
      `${relative(sourceFile)}: web unit tests must mirror app ownership under tests/unit`,
    );
    continue;
  }
  if (sourceFile.startsWith(`${webApiRoot}${path.sep}`)) continue;
  if (
    sourceFile.startsWith(`${webPagesRoot}${path.sep}`) &&
    /^(?:api|.+-api)\.ts$/.test(path.basename(sourceFile))
  ) {
    failures.push(
      `${relative(sourceFile)}: page-local API modules are forbidden; use app/lib/api/endpoints`,
    );
  }
  const source = fs.readFileSync(sourceFile, "utf8");
  if (/\bfetch\s*\(|\bapiClient\s*\./.test(source)) {
    failures.push(
      `${relative(sourceFile)}: browser requests must be defined in app/lib/api`,
    );
  }
  if (/from\s+['"]~\/lib\/api\//.test(source)) {
    failures.push(
      `${relative(sourceFile)}: import the public ~/lib/api facade instead of API internals`,
    );
  }
}

const npmrcPath = path.join(repositoryRoot, ".npmrc");
const lockfilePath = path.join(repositoryRoot, "pnpm-lock.yaml");
requireFile(npmrcPath);
requireFile(path.join(repositoryRoot, ".nvmrc"));
requireFile(lockfilePath);
for (const environmentTemplate of [
  "apps/api/.env.example",
  "apps/web/.env.example",
  "deploy/.env.example",
]) {
  requireFile(path.join(repositoryRoot, environmentTemplate));
}
forbidPath(
  path.join(repositoryRoot, ".env.example"),
  "environment templates must be owned by their runtime surface",
);
if (fs.existsSync(npmrcPath)) {
  const allowedNpmRegistries = new Set([
    "https://registry.npmjs.org/",
    "https://registry.npmmirror.com/",
  ]);
  const registrySettings = fs
    .readFileSync(npmrcPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line && !/^[#;]/.test(line) && /(?:^|:)registry\s*=/.test(line),
    );
  if (
    !registrySettings.length ||
    registrySettings.some(
      (line) =>
        !allowedNpmRegistries.has(
          line.slice(line.indexOf("=") + 1).trim(),
        ),
    )
  ) {
    failures.push(
      `.npmrc: every configured registry must be one of ${[...allowedNpmRegistries].join(", ")}`,
    );
  }
}
if (fs.existsSync(lockfilePath)) {
  const lockfile = fs.readFileSync(lockfilePath, "utf8");
  const unsupportedTarballs = [...lockfile.matchAll(/tarball:\s*([^\s,}]+)/g)]
    .map((match) => match[1])
    .filter((url) => {
      try {
        return new URL(url).hostname !== "registry.npmjs.org";
      } catch {
        return true;
      }
    });
  if (unsupportedTarballs.length) {
    failures.push(
      `pnpm-lock.yaml: non-official tarball source(s): ${unsupportedTarballs.join(", ")}`,
    );
  }
}

validateDefaultScripts(rootPackage, { api: apiPackage, web: webPackage });

forbidPath(legacyRoot, "Legacy is maintained in a separate private repository");
requireFile(path.join(apiRoot, "src/app.ts"));
requireFile(path.join(apiRoot, "src/main.ts"));
forbidPath(
  path.join(apiRoot, "src/server"),
  "API source must be rooted directly at apps/api/src",
);
for (const retiredWorkerSurface of [
  "src/worker.ts",
  "src/runtime/cloudflare-services.ts",
  "src/runtime/worker-bindings.ts",
  "src/infra/cache/d1",
  "src/infra/db/d1",
  "src/infra/http/cloudflare-assets",
  "src/infra/http/web-form-data",
  "src/infra/media/cloudflare-images",
  "src/infra/oss/r2",
  "src/infra/security/bcryptjs",
  "tests/worker",
  "tsconfig.worker.json",
  "vitest.config.mts",
  "worker-configuration.d.ts",
  "wrangler.jsonc",
  ".assetsignore",
]) {
  forbidPath(
    path.join(apiRoot, retiredWorkerSurface),
    "Cloudflare Worker runtime is retired; current API validation is Node-only",
  );
}
for (const forbiddenRoot of [
  "src",
  "js",
  "migrations",
  "tsconfig.server.json",
  "tsconfig.worker.json",
  "vitest.config.mts",
  "worker-configuration.d.ts",
  "wrangler.jsonc",
]) {
  forbidPath(
    path.join(repositoryRoot, forbiddenRoot),
    "application code must live in a workspace",
  );
}
for (const appRoot of [apiRoot, webRoot]) {
  forbidPath(
    path.join(appRoot, "compose.yaml"),
    "deployment composition must live under deploy",
  );
  forbidPath(
    path.join(appRoot, "deploy"),
    "deployment configuration must live in the repository deploy directory",
  );
}
forbidPath(
  path.join(repositoryRoot, "compose.yaml"),
  "deployment composition must live under deploy",
);
forbidPath(
  path.join(repositoryRoot, "compose.emergency.yaml"),
  "deployment composition must live under deploy",
);
forbidPath(
  path.join(apiRoot, "public"),
  "API release assets must be generated from the Web build",
);
forbidPath(
  path.join(repositoryRoot, "public"),
  "frontend assets must be owned by apps/web",
);
requireFile(path.join(repositoryRoot, "data/.gitignore"));
forbidPath(
  path.join(repositoryRoot, "pyproject.toml"),
  "the public monorepo has no root Python project",
);
forbidPath(
  path.join(repositoryRoot, "uv.lock"),
  "the public monorepo has no root Python lockfile",
);
forbidPath(
  path.join(repositoryRoot, ".python-version"),
  "the public monorepo has no root Python version pin",
);
for (const forbiddenLegacySurface of [
  "flask",
  "public/app.py",
  "public/templates",
  "src/server/routes/wiki.ts",
]) {
  forbidPath(
    path.join(apiRoot, forbiddenLegacySurface),
    "retired runtime surface is forbidden in the API workspace",
  );
}

for (const sourceFile of filesUnder(
  apiRoot,
  workspaceDependencyRoots(apiRoot, { wrangler: true }),
)) {
  if (/\.(?:py|pyc|pyo)$/i.test(sourceFile)) {
    failures.push(
      `${relative(sourceFile)}: Python is forbidden in the API workspace`,
    );
  }
}

const apiDependencies = {
  ...apiPackage.dependencies,
  ...apiPackage.devDependencies,
};
for (const dependency of [
  "express",
  "cookie-parser",
  "cors",
  "helmet",
  "multer",
  "jsonwebtoken",
]) {
  if (apiDependencies[dependency]) {
    failures.push(
      `apps/api/package.json: legacy dependency remains: ${dependency}`,
    );
  }
}
for (const dependency of [
  "@cloudflare/vitest-pool-workers",
  "@cloudflare/workers-types",
  "wrangler",
]) {
  if (apiDependencies[dependency]) {
    failures.push(
      `apps/api/package.json: retired Worker dependency remains: ${dependency}`,
    );
  }
}
const composePath = path.join(repositoryRoot, "deploy/compose.yaml");
requireFile(composePath);
const currentComposeSource = fs.existsSync(composePath)
  ? fs.readFileSync(composePath, "utf8")
  : "";
if (
  /ims_(?:legacy_)?flask|IMS_(?:LEGACY_)?FLASK_UPSTREAM|(?:^|[^0-9])5000(?:[^0-9]|$)|apps\/legacy/i.test(
    currentComposeSource,
  )
) {
  failures.push(
    "Current Compose deployment must not restore a retired runtime",
  );
}
if (
  /^\s{2}nginx\s*:/im.test(currentComposeSource) ||
  /IMS_NGINX|nginx:\S*/i.test(currentComposeSource)
) {
  failures.push("deploy/compose.yaml must not provision Nginx");
}
const composeFiles = filesUnder(path.join(repositoryRoot, "deploy"))
  .filter((file) => /(?:^|\/)compose(?:\.[^.]+)?\.ya?ml$/i.test(relative(file)))
  .map((file) => relative(file))
  .sort();
const expectedComposeFiles = ["deploy/compose.yaml"];
if (JSON.stringify(composeFiles) !== JSON.stringify(expectedComposeFiles)) {
  failures.push(
    `deploy: expected only ${expectedComposeFiles.join(" and ")}, found ${composeFiles.join(", ")}`,
  );
}

const clientRoot = path.join(apiRoot, "dist/client");
for (const outputFile of filesUnder(clientRoot)) {
  const outputRelative = path
    .relative(clientRoot, outputFile)
    .split(path.sep)
    .join("/")
    .toLowerCase();
  if (
    /(?:^|\/)(?:data|database|templates|uploads|logs|venv|\.venv|__pycache__|legacy)(?:\/|$)/.test(
      outputRelative,
    ) ||
    /\.(?:db|sqlite3?|py|pyc|ini|log|sql|wal|shm|data)$/.test(outputRelative)
  ) {
    failures.push(
      `${relative(outputFile)}: forbidden file in Hono client output`,
    );
  }
}

if (failures.length) {
  throw new Error(`Workspace boundary check failed:\n${failures.join("\n")}`);
}
process.stdout.write(
  "Workspace boundary check passed: root orchestrator, API, web, data, and deployment surfaces are isolated\n",
);
