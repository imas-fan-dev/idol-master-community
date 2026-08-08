#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "../..");

export const minimumNodeVersion = Object.freeze([22, 13, 0]);
const defaultApiPort = 3000;
const defaultWebPort = 5173;
const loopbackHost = "127.0.0.1";
const readinessTimeoutMs = 90_000;
const supportedPlatforms = new Set(["darwin", "linux", "win32"]);

const localInfrastructureDefaults = Object.freeze({
  IMS_POSTGRES_PORT: "5432",
  IMS_POSTGRES_DB: "imsweb",
  IMS_POSTGRES_USER: "imsweb",
  IMS_POSTGRES_PASSWORD: "imsweb-local-password",
  IMS_RUSTFS_API_PORT: "9000",
  IMS_RUSTFS_CONSOLE_PORT: "9001",
  IMS_RUSTFS_ACCESS_KEY: "imsweb-local",
  IMS_RUSTFS_SECRET_KEY: "imsweb-local-password",
  IMS_RUSTFS_BUCKET: "imsweb-media-local",
});

function usage() {
  return `IMSWeb local development environment

Usage:
  pnpm dev [--api-port PORT] [--web-port PORT]
  pnpm run dev:r2 [--api-port PORT] [--web-port PORT]
  pnpm run dev:doctor
  pnpm run dev:down

Options:
  --api-port PORT  Hono port (default: ${defaultApiPort})
  --web-port PORT  React Router port (default: ${defaultWebPort})
  --r2             Use the R2 test bucket configured in apps/api/.env
  --doctor         Check prerequisites without changing local state
  --down           Stop local PostgreSQL and RustFS without deleting data
  --dry-run        Print the startup plan without executing it
  -h, --help       Show this help

Environment overrides:
  IMS_DEV_API_PORT, IMS_DEV_WEB_PORT, IMS_DEV_R2_ENV_FILE
  IMS_DEV_FUDABA_PUBLIC_READ_ENABLED, IMS_DEV_FUDABA_WRITE_ENABLED
  IMS_DEV_FUDABA_MAP_ENABLED, IMS_DEV_FUDABA_MAP_STYLE_URL
`;
}

function parsePort(value, optionName) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${optionName} must be an integer between 1 and 65535`);
  }
  return port;
}

export function parseArguments(argv, environment = process.env) {
  const options = {
    apiPort: parsePort(
      environment.IMS_DEV_API_PORT || defaultApiPort,
      "IMS_DEV_API_PORT",
    ),
    webPort: parsePort(
      environment.IMS_DEV_WEB_PORT || defaultWebPort,
      "IMS_DEV_WEB_PORT",
    ),
    doctor: false,
    down: false,
    dryRun: false,
    help: false,
    r2: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--doctor") {
      options.doctor = true;
      continue;
    }
    if (argument === "--down") {
      options.down = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--r2") {
      options.r2 = true;
      continue;
    }
    if (argument === "--api-port" || argument === "--web-port") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a port`);
      const key = argument === "--api-port" ? "apiPort" : "webPort";
      options[key] = parsePort(value, argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  const selectedModes = [options.doctor, options.down].filter(Boolean).length;
  if (selectedModes > 1)
    throw new Error("--doctor and --down cannot be combined");
  if (options.apiPort === options.webPort) {
    throw new Error("API and Web ports must be different");
  }
  return options;
}

export function versionAtLeast(version, minimum = minimumNodeVersion) {
  const parsed = String(version)
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number(part));
  if (parsed.length !== 3 || parsed.some((part) => !Number.isInteger(part))) {
    return false;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] > minimum[index]) return true;
    if (parsed[index] < minimum[index]) return false;
  }
  return true;
}

function readEnvironmentFile(environmentPath) {
  if (!fs.existsSync(environmentPath)) return {};
  try {
    return parseEnv(fs.readFileSync(environmentPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse ${path.relative(repositoryRoot, environmentPath)}: ${error.message}`,
    );
  }
}

function sanitizedApplicationEnvironment(environment) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (
      name.startsWith("IMS_") ||
      name === "DATABASE_URL" ||
      name === "AWS_ACCESS_KEY_ID" ||
      name === "AWS_SECRET_ACCESS_KEY" ||
      name === "AWS_SESSION_TOKEN" ||
      name === "AWS_SECURITY_TOKEN"
    ) {
      delete sanitized[name];
    }
  }
  return sanitized;
}

function developmentBooleanFlag(environment, name) {
  const value = String(environment[name] || "").trim().toLowerCase();
  if (!value) return "false";
  if (value === "true" || value === "false") return value;
  throw new Error(`${name} must be true or false`);
}

function developmentMapStyleUrl(environment) {
  const rawValue = String(environment.IMS_DEV_FUDABA_MAP_STYLE_URL || "");
  const value = rawValue.trim();
  if (!value) return "";
  if (
    value.length > 2_048 ||
    /[\0-\x1f\x7f]/.test(rawValue) ||
    !value.startsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      "IMS_DEV_FUDABA_MAP_STYLE_URL must be a same-origin absolute path " +
        "without query or hash",
    );
  }
  return value;
}

function resolveFudabaDevelopmentEnvironment(environment) {
  const mapEnabled = developmentBooleanFlag(
    environment,
    "IMS_DEV_FUDABA_MAP_ENABLED",
  );
  const mapStyleUrl = developmentMapStyleUrl(environment);
  if (mapEnabled === "true" && !mapStyleUrl) {
    throw new Error(
      "IMS_DEV_FUDABA_MAP_STYLE_URL is required when " +
        "IMS_DEV_FUDABA_MAP_ENABLED=true",
    );
  }
  return {
    IMS_FUDABA_PUBLIC_READ_ENABLED: developmentBooleanFlag(
      environment,
      "IMS_DEV_FUDABA_PUBLIC_READ_ENABLED",
    ),
    IMS_FUDABA_WRITE_ENABLED: developmentBooleanFlag(
      environment,
      "IMS_DEV_FUDABA_WRITE_ENABLED",
    ),
    IMS_FUDABA_MAP_ENABLED: mapEnabled,
    IMS_FUDABA_MAP_STYLE_URL: mapStyleUrl,
  };
}

function encodedPostgresUrl({ host, port, database, username, password }) {
  const url = new URL("postgresql://localhost");
  url.hostname = host;
  url.port = String(port);
  url.username = username;
  url.password = password;
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function requiredR2Value(environment, name) {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required for R2 hot reload`);
  return value;
}

function parseCredentialFreeUrl(name, value, { r2Endpoint = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  if (
    r2Endpoint &&
    (!parsed.hostname.endsWith(".r2.cloudflarestorage.com") ||
      (parsed.pathname !== "/" && parsed.pathname !== ""))
  ) {
    throw new Error(
      `${name} must be a Cloudflare R2 S3 API endpoint without a path`,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function resolveR2StorageEnvironment(environment) {
  const storageType = requiredR2Value(
    environment,
    "IMS_OBJECT_STORAGE",
  ).toLowerCase();
  if (storageType !== "s3") {
    throw new Error("R2 hot reload requires IMS_OBJECT_STORAGE=s3");
  }

  const bucket = requiredR2Value(environment, "IMS_S3_BUCKET");
  if (!/(?:^|[._-])test(?:$|[._-])/.test(bucket.toLowerCase())) {
    throw new Error(
      "R2 hot reload refuses a bucket whose name is not explicitly marked as test",
    );
  }
  if (String(environment.IMS_S3_PUBLIC_BUCKET || "").trim()) {
    throw new Error(
      "IMS_S3_PUBLIC_BUCKET is unsupported; R2 hot reload uses one test bucket",
    );
  }

  const publicReadUrl = requiredR2Value(
    {
      IMS_PUBLIC_READ_URL_BASE:
        environment.IMS_PUBLIC_READ_URL_BASE ||
        environment.IMS_S3_PUBLIC_READ_URL_BASE,
    },
    "IMS_PUBLIC_READ_URL_BASE",
  );
  const publicReadUrlBase = parseCredentialFreeUrl(
    "IMS_PUBLIC_READ_URL_BASE",
    publicReadUrl,
  );
  const legacyPublicReadUrl = String(
    environment.IMS_S3_PUBLIC_READ_URL_BASE || "",
  ).trim();
  if (
    legacyPublicReadUrl &&
    parseCredentialFreeUrl(
      "IMS_S3_PUBLIC_READ_URL_BASE",
      legacyPublicReadUrl,
    ) !== publicReadUrlBase
  ) {
    throw new Error(
      "IMS_PUBLIC_READ_URL_BASE and IMS_S3_PUBLIC_READ_URL_BASE must match",
    );
  }

  const region = requiredR2Value(environment, "IMS_S3_REGION");
  if (region !== "auto") {
    throw new Error("R2 hot reload requires IMS_S3_REGION=auto");
  }
  const endpoint = parseCredentialFreeUrl(
    "IMS_S3_ENDPOINT",
    requiredR2Value(environment, "IMS_S3_ENDPOINT"),
    { r2Endpoint: true },
  );
  const forcePathStyle = String(environment.IMS_S3_FORCE_PATH_STYLE || "false")
    .trim()
    .toLowerCase();
  if (!["false", "0", "no", "off"].includes(forcePathStyle)) {
    throw new Error("R2 hot reload requires IMS_S3_FORCE_PATH_STYLE=false");
  }

  const prefix = String(environment.IMS_S3_PREFIX || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const prefixSegments = prefix ? prefix.split("/") : [];
  if (
    prefix.includes("\\") ||
    prefixSegments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    throw new Error("IMS_S3_PREFIX must be a valid object-key prefix");
  }
  const readUrlTtlSeconds = String(
    environment.IMS_S3_READ_URL_TTL_SECONDS || "300",
  ).trim();
  const ttl = Number(readUrlTtlSeconds);
  if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 3_600) {
    throw new Error(
      "IMS_S3_READ_URL_TTL_SECONDS must be an integer between 30 and 3600",
    );
  }

  const accessKeyId = requiredR2Value(environment, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = requiredR2Value(environment, "AWS_SECRET_ACCESS_KEY");
  const sessionToken = String(environment.AWS_SESSION_TOKEN || "").trim();

  return {
    IMS_OBJECT_STORAGE: "s3",
    IMS_S3_BUCKET: bucket,
    IMS_PUBLIC_READ_URL_BASE: publicReadUrlBase,
    IMS_S3_PUBLIC_READ_URL_BASE: publicReadUrlBase,
    IMS_S3_PUBLIC_BUCKET: "",
    IMS_S3_REGION: "auto",
    IMS_S3_ENDPOINT: endpoint,
    IMS_S3_FORCE_PATH_STYLE: "false",
    IMS_S3_PREFIX: prefix,
    IMS_S3_READ_URL_TTL_SECONDS: readUrlTtlSeconds,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    ...(sessionToken ? { AWS_SESSION_TOKEN: sessionToken } : {}),
  };
}

export function resolveDevelopmentConfiguration({
  environment = process.env,
  deployEnvironment = readEnvironmentFile(
    path.join(repositoryRoot, "deploy/.env"),
  ),
  options = parseArguments([], environment),
  r2Environment = options.r2
    ? readEnvironmentFile(
        path.resolve(
          repositoryRoot,
          environment.IMS_DEV_R2_ENV_FILE || "apps/api/.env",
        ),
      )
    : {},
} = {}) {
  const infrastructure = {
    ...localInfrastructureDefaults,
    ...deployEnvironment,
    ...environment,
  };
  const postgresPort = parsePort(
    infrastructure.IMS_POSTGRES_PORT,
    "IMS_POSTGRES_PORT",
  );
  const rustfsPort = parsePort(
    infrastructure.IMS_RUSTFS_API_PORT,
    "IMS_RUSTFS_API_PORT",
  );
  const rustfsConsolePort = parsePort(
    infrastructure.IMS_RUSTFS_CONSOLE_PORT,
    "IMS_RUSTFS_CONSOLE_PORT",
  );
  const database = infrastructure.IMS_POSTGRES_DB;
  const username = infrastructure.IMS_POSTGRES_USER;
  const password = infrastructure.IMS_POSTGRES_PASSWORD;
  const rustfsAccessKey = infrastructure.IMS_RUSTFS_ACCESS_KEY;
  const rustfsSecretKey = infrastructure.IMS_RUSTFS_SECRET_KEY;
  const bucket = infrastructure.IMS_RUSTFS_BUCKET;

  const requiredInfrastructure = {
    IMS_POSTGRES_DB: database,
    IMS_POSTGRES_USER: username,
    IMS_POSTGRES_PASSWORD: password,
    ...(!options.r2
      ? {
          IMS_RUSTFS_ACCESS_KEY: rustfsAccessKey,
          IMS_RUSTFS_SECRET_KEY: rustfsSecretKey,
          IMS_RUSTFS_BUCKET: bucket,
        }
      : {}),
  };
  for (const [name, value] of Object.entries(requiredInfrastructure)) {
    if (!String(value || "").trim()) throw new Error(`${name} cannot be empty`);
  }

  const apiOrigin = `http://${loopbackHost}:${options.apiPort}`;
  const webOrigin = `http://${loopbackHost}:${options.webPort}`;
  const rustfsOrigin = `http://${loopbackHost}:${rustfsPort}`;
  const rustfsConsoleOrigin = `http://${loopbackHost}:${rustfsConsolePort}`;
  const databaseUrl = encodedPostgresUrl({
    host: loopbackHost,
    port: postgresPort,
    database,
    username,
    password,
  });
  const composePath = path.join(repositoryRoot, "deploy/compose.yaml");
  const deployEnvironmentPath = path.join(repositoryRoot, "deploy/.env");
  const composeArguments = ["compose"];
  if (fs.existsSync(deployEnvironmentPath)) {
    composeArguments.push("--env-file", deployEnvironmentPath);
  }
  if (!options.r2) composeArguments.push("--profile", "local-storage");
  composeArguments.push("-f", composePath);

  const applicationEnvironment = sanitizedApplicationEnvironment(environment);
  const objectStorageEnvironment = options.r2
    ? resolveR2StorageEnvironment(r2Environment)
    : {
        IMS_OBJECT_STORAGE: "s3",
        IMS_S3_BUCKET: bucket,
        IMS_PUBLIC_READ_URL_BASE: `${rustfsOrigin}/${bucket}`,
        IMS_S3_PUBLIC_READ_URL_BASE: `${rustfsOrigin}/${bucket}`,
        IMS_S3_PUBLIC_BUCKET: "",
        IMS_S3_REGION: "us-east-1",
        IMS_S3_ENDPOINT: rustfsOrigin,
        IMS_S3_FORCE_PATH_STYLE: "true",
        IMS_S3_PREFIX: "",
        IMS_S3_READ_URL_TTL_SECONDS: "300",
        AWS_ACCESS_KEY_ID: rustfsAccessKey,
        AWS_SECRET_ACCESS_KEY: rustfsSecretKey,
      };
  const apiEnvironment = {
    ...applicationEnvironment,
    NODE_ENV: "development",
    HOST: loopbackHost,
    PORT: String(options.apiPort),
    IMS_ENV_FILE: "",
    IMS_PROJECT_ROOT: repositoryRoot,
    IMS_BACKOFFICE_JWT_SECRET: "imsweb-local-development-secret",
    IMS_PLATFORM_JWT_SECRET: "imsweb-local-development-platform-secret",
    IMS_COOKIE_SECURE: "false",
    IMS_CLIENT_ADDRESS_SOURCE: "direct",
    ...resolveFudabaDevelopmentEnvironment(environment),
    DATABASE_URL: databaseUrl,
    ...objectStorageEnvironment,
    IMS_PUBLIC_DIR: "apps/api/dist/node-client",
    IMS_COMPENSATION_DIR: "data/core/compensation",
    IMS_IDEMPOTENCY_DIR: "data/core/idempotency",
    IMS_UPLOADS_DIR: "data/uploads",
    IMS_EVENT_BASE_DIR: "data/chronicle",
    IMS_STORY_DATA_DIR: "data/story/images",
  };
  delete apiEnvironment.AWS_SECURITY_TOKEN;

  return {
    ...options,
    apiOrigin,
    webOrigin,
    rustfsOrigin,
    rustfsConsoleOrigin,
    databaseUrl,
    postgresPort,
    rustfsPort,
    database,
    username,
    bucket: apiEnvironment.IMS_S3_BUCKET,
    publicReadUrlBase: apiEnvironment.IMS_PUBLIC_READ_URL_BASE,
    storageMode: options.r2 ? "r2" : "rustfs",
    composeArguments,
    composeEnvironment: {
      ...environment,
      ...infrastructure,
    },
    apiEnvironment,
    webEnvironment: {
      ...applicationEnvironment,
      IMS_API_ORIGIN: apiOrigin,
    },
  };
}

export function buildCommandPlan(configuration) {
  const compose = configuration.composeArguments;
  const usesRustfs = configuration.storageMode === "rustfs";
  return {
    composeConfig: {
      command: "docker",
      args: [...compose, "config", "--quiet"],
      env: configuration.composeEnvironment,
    },
    composeRuntime: {
      command: "docker",
      args: [...compose, "ps", "--quiet"],
      env: configuration.composeEnvironment,
    },
    infrastructure: {
      command: "docker",
      args: [
        ...compose,
        "up",
        "-d",
        "postgres",
        ...(usesRustfs ? ["rustfs"] : []),
      ],
      env: configuration.composeEnvironment,
    },
    postgresReady: {
      command: "docker",
      args: [
        ...compose,
        "exec",
        "-T",
        "postgres",
        "pg_isready",
        "-U",
        configuration.username,
        "-d",
        configuration.database,
      ],
      env: configuration.composeEnvironment,
    },
    rustfsInit: usesRustfs
      ? {
          command: "docker",
          args: [...compose, "run", "--rm", "--no-deps", "rustfs-init"],
          env: configuration.composeEnvironment,
        }
      : undefined,
    migrate: {
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["--filter", "@imsweb/api", "run", "migration:postgresql"],
      env: configuration.apiEnvironment,
    },
    api: {
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["--filter", "@imsweb/api", "run", "dev"],
      env: configuration.apiEnvironment,
    },
    web: {
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: [
        "--filter",
        "@imsweb/web",
        "exec",
        "react-router",
        "dev",
        "--host",
        loopbackHost,
        "--port",
        String(configuration.webPort),
        "--strictPort",
      ],
      env: configuration.webEnvironment,
    },
    down: {
      command: "docker",
      args: [
        ...compose,
        "stop",
        ...(usesRustfs ? ["rustfs-init", "rustfs"] : []),
        "postgres",
      ],
      env: configuration.composeEnvironment,
    },
  };
}

function printableCommand(specification) {
  const quote = (value) =>
    /^[A-Za-z0-9_./:@=-]+$/.test(value)
      ? value
      : `'${value.replaceAll("'", "'\\''")}'`;
  return [specification.command, ...specification.args].map(quote).join(" ");
}

function runCommand(label, specification, { quiet = false } = {}) {
  process.stdout.write(`[dev] ${label}\n`);
  const useShell = process.platform === "win32" && specification.command.endsWith(".cmd");
  const result = spawnSync(specification.command, specification.args, {
    cwd: repositoryRoot,
    env: specification.env || process.env,
    stdio: quiet ? "ignore" : "inherit",
    timeout: specification.timeout,
    shell: useShell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function probeCommand(specification) {
  const useShell = process.platform === "win32" && specification.command.endsWith(".cmd");
  const result = spawnSync(specification.command, specification.args, {
    cwd: repositoryRoot,
    env: specification.env || process.env,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10_000,
    shell: useShell,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout?.trim(),
    stderr: result.stderr?.trim(),
    detail:
      result.error?.message || result.stderr?.trim() || result.stdout?.trim(),
  };
}

export function isLocalContainerEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) return false;
  if (/^(?:unix|npipe|fd):\/\//i.test(value)) return true;
  if (path.isAbsolute(value)) return true;

  try {
    const hostname = new URL(value).hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
}

function containerTarget(source, endpoint, detail) {
  const normalizedEndpoint = String(endpoint || "").trim();
  return {
    source,
    endpoint: normalizedEndpoint,
    detail,
    local: isLocalContainerEndpoint(normalizedEndpoint),
  };
}

function dockerContextEndpoint(output) {
  for (const line of String(output || "").split("\n")) {
    const value = line.trim();
    if (!value) continue;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value;
    }
  }
  return "";
}

function podmanConnectionTarget(output, requestedConnection) {
  try {
    const connections = JSON.parse(String(output || ""));
    if (!Array.isArray(connections)) return undefined;
    const selected = requestedConnection
      ? connections.find((entry) => entry.Name === requestedConnection)
      : connections.find((entry) => entry.Default);
    if (!selected?.URI) return undefined;
    return containerTarget(
      requestedConnection
        ? "CONTAINER_CONNECTION"
        : "Podman default connection",
      selected.URI,
    );
  } catch {
    return undefined;
  }
}

export function inspectContainerTarget(
  environment = process.env,
  probe = probeCommand,
) {
  const containerCliVersion = probe({
    command: "docker",
    args: ["--version"],
    env: environment,
  });
  const isPodmanCli =
    containerCliVersion.ok &&
    /podman/i.test(
      `${containerCliVersion.stdout || ""}\n${containerCliVersion.stderr || ""}`,
    );

  const dockerHostTarget = environment.DOCKER_HOST
    ? containerTarget("DOCKER_HOST", environment.DOCKER_HOST)
    : undefined;
  const containerHostTarget = environment.CONTAINER_HOST
    ? containerTarget("CONTAINER_HOST", environment.CONTAINER_HOST)
    : undefined;
  const unsafeExplicitEndpoint = [dockerHostTarget, containerHostTarget].find(
    (target) => target && !target.local,
  );
  if (unsafeExplicitEndpoint) return unsafeExplicitEndpoint;

  let dockerContextTarget;
  if (environment.DOCKER_CONTEXT) {
    const context = probe({
      command: "docker",
      args: [
        "context",
        "inspect",
        environment.DOCKER_CONTEXT,
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
      env: environment,
    });
    const endpoint = context.ok ? dockerContextEndpoint(context.stdout) : "";
    dockerContextTarget = endpoint
      ? containerTarget(
          `Docker context ${environment.DOCKER_CONTEXT}`,
          endpoint,
        )
      : containerTarget(
          `Docker context ${environment.DOCKER_CONTEXT}`,
          "",
          context.detail || "the context endpoint could not be resolved",
        );
    if (!dockerContextTarget.local) return dockerContextTarget;
  }

  if (!containerCliVersion.ok) {
    return containerTarget(
      "container CLI",
      "",
      containerCliVersion.detail || "the container CLI could not be identified",
    );
  }

  let connections;
  let requestedConnectionTarget;
  if (environment.CONTAINER_CONNECTION) {
    connections = probe({
      command: "docker",
      args: ["system", "connection", "list", "--format", "json"],
      env: environment,
    });
    requestedConnectionTarget = connections.ok
      ? podmanConnectionTarget(
          connections.stdout,
          environment.CONTAINER_CONNECTION,
        )
      : undefined;
    requestedConnectionTarget =
      requestedConnectionTarget ||
      containerTarget(
        "CONTAINER_CONNECTION",
        "",
        connections.detail ||
          `connection ${environment.CONTAINER_CONNECTION} was not found`,
      );
    if (!requestedConnectionTarget.local) return requestedConnectionTarget;
  }

  if (!isPodmanCli) {
    if (dockerContextTarget) return dockerContextTarget;
    if (dockerHostTarget) return dockerHostTarget;

    const context = probe({
      command: "docker",
      args: [
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
      env: environment,
    });
    const endpoint = context.ok ? dockerContextEndpoint(context.stdout) : "";
    return endpoint
      ? containerTarget("Docker context", endpoint)
      : containerTarget(
          "Docker context",
          "",
          context.detail ||
            "the active Docker context endpoint could not be resolved",
        );
  }

  if (containerHostTarget) return containerHostTarget;
  if (requestedConnectionTarget) return requestedConnectionTarget;

  connections ||= probe({
    command: "docker",
    args: ["system", "connection", "list", "--format", "json"],
    env: environment,
  });
  const podmanTarget = connections.ok
    ? podmanConnectionTarget(connections.stdout)
    : undefined;
  return (
    podmanTarget ||
    containerTarget(
      "container CLI",
      "",
      connections.detail ||
        "the active container endpoint could not be resolved",
    )
  );
}

function printableContainerEndpoint(endpoint) {
  if (!endpoint) return "unresolved";
  try {
    const parsed = new URL(endpoint);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return endpoint;
  }
}

function assertLocalContainerTarget(target) {
  if (target.local) return;
  const endpoint = printableContainerEndpoint(target.endpoint);
  throw new Error(
    `Refusing to modify a non-local container target (${target.source}: ${endpoint}). ` +
      "Switch to a local Docker/Podman context and rerun pnpm run dev:doctor.",
  );
}

async function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) =>
      resolve({ available: false, code: error.code, message: error.message }),
    );
    server.listen({ host: loopbackHost, port }, () => {
      server.close(() => resolve({ available: true }));
    });
  });
}

function portFailureHint(probe, port, service) {
  if (probe.code === "EADDRINUSE") {
    return `${service} port ${port} is already in use; stop that process or select another port`;
  }
  return `${service} port ${port} could not be checked (${probe.code || probe.message})`;
}

async function waitForCommand(label, specification, timeoutMs = 60_000) {
  process.stdout.write(`[dev] ${label}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeCommand(specification).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const result = probeCommand(specification);
  throw new Error(
    `${label} timed out${result.detail ? `: ${result.detail.split("\n")[0]}` : ""}`,
  );
}

async function waitForUrl(label, url, child, timeoutMs = readinessTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${label} process exited before becoming ready`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The watcher may still be compiling or opening its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1_000}s`);
}

function startWatchProcess(label, specification) {
  process.stdout.write(
    `[dev] Starting ${label}: ${printableCommand(specification)}\n`,
  );
  const useShell = process.platform === "win32" && specification.command.endsWith(".cmd");
  return spawn(specification.command, specification.args, {
    cwd: repositoryRoot,
    env: specification.env || process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
    shell: useShell,
  });
}

async function supervise(configuration, plan) {
  const children = [];
  let requestedSignal;
  let signalResolve;
  const signalPromise = new Promise((resolve) => {
    signalResolve = resolve;
  });
  const onSignal = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    signalResolve({ type: "signal", signal });
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const registerChild = (label, child) => {
    const outcome = new Promise((resolve) => {
      child.once("error", (error) =>
        resolve({ type: "exit", label, error, code: null, signal: null }),
      );
      child.once("exit", (code, signal) =>
        resolve({ type: "exit", label, error: null, code, signal }),
      );
    });
    const entry = { label, child, outcome };
    children.push(entry);
    return entry;
  };

  const signalChild = (child, signal) => {
    if (!child.pid) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process group may already have exited; fall back to its parent.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // A concurrent watcher exit needs no further cleanup.
    }
  };

  const stopChildren = (signal = "SIGTERM") => {
    for (const entry of children) {
      signalChild(entry.child, signal);
    }
  };

  const unexpectedExitError = (outcome, context) => {
    const detail =
      outcome.error?.message || outcome.signal || outcome.code || 0;
    return new Error(`${outcome.label} exited ${context} (${detail})`);
  };

  try {
    const api = registerChild(
      "Hono API",
      startWatchProcess("Hono API", plan.api),
    );
    const apiReadiness = await Promise.race([
      waitForUrl(
        "Hono API",
        `${configuration.apiOrigin}/api/wiki/test`,
        api.child,
      ).then(() => ({ type: "ready" })),
      signalPromise,
      api.outcome,
    ]);
    if (apiReadiness.type === "signal") return;
    if (apiReadiness.type === "exit") {
      throw unexpectedExitError(apiReadiness, "before becoming ready");
    }

    const web = registerChild(
      "React Web",
      startWatchProcess("React Web", plan.web),
    );
    const webReadiness = await Promise.race([
      waitForUrl("React Web", configuration.webOrigin, web.child).then(() => ({
        type: "ready",
      })),
      signalPromise,
      api.outcome,
      web.outcome,
    ]);
    if (webReadiness.type === "signal") return;
    if (webReadiness.type === "exit") {
      throw unexpectedExitError(webReadiness, "before Web became ready");
    }
    const proxyReadiness = await Promise.race([
      waitForUrl(
        "Web API proxy",
        `${configuration.webOrigin}/api/wiki/test`,
        web.child,
      ).then(() => ({ type: "ready" })),
      signalPromise,
      api.outcome,
      web.outcome,
    ]);
    if (proxyReadiness.type === "signal") return;
    if (proxyReadiness.type === "exit") {
      throw unexpectedExitError(
        proxyReadiness,
        "before the Web proxy became ready",
      );
    }

    process.stdout.write("\n[dev] Development environment is ready\n");
    process.stdout.write(`[dev] Web:           ${configuration.webOrigin}\n`);
    process.stdout.write(`[dev] API:           ${configuration.apiOrigin}\n`);
    if (configuration.storageMode === "r2") {
      process.stdout.write(`[dev] R2 test bucket: ${configuration.bucket}\n`);
      process.stdout.write(
        `[dev] R2 public URL:  ${configuration.publicReadUrlBase}\n`,
      );
    } else {
      process.stdout.write(
        `[dev] RustFS console: ${configuration.rustfsConsoleOrigin}\n`,
      );
    }
    process.stdout.write(
      "[dev] Press Ctrl+C to stop API and Web. Local data services stay running.\n\n",
    );

    const outcome = await Promise.race([
      signalPromise,
      ...children.map((entry) => entry.outcome),
    ]);
    if (outcome.type === "exit") {
      throw unexpectedExitError(outcome, "unexpectedly");
    }
  } finally {
    stopChildren(requestedSignal === "SIGINT" ? "SIGINT" : "SIGTERM");
    const childOutcomes = Promise.all(children.map((entry) => entry.outcome));
    let killTimer;
    const stoppedGracefully = await Promise.race([
      childOutcomes.then(() => true),
      new Promise((resolve) => {
        killTimer = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    clearTimeout(killTimer);
    if (!stoppedGracefully) {
      stopChildren("SIGKILL");
      await childOutcomes;
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (requestedSignal === "SIGINT") process.exitCode = 130;
    if (requestedSignal === "SIGTERM") process.exitCode = 143;
  }
}

function dependencyExecutable(relativePath) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return fs.existsSync(path.join(repositoryRoot, `${relativePath}${suffix}`));
}

async function doctor(configuration, plan) {
  const checks = [];
  checks.push({
    label: `Platform ${process.platform} (macOS/Linux required)`,
    ok: supportedPlatforms.has(process.platform),
    hint: "use WSL2 when developing on Windows",
  });
  checks.push({
    label: `Node ${process.versions.node} (requires >=22.13.0)`,
    ok: versionAtLeast(process.versions.node),
  });
  checks.push({
    label: "API dependencies installed",
    ok: dependencyExecutable("apps/api/node_modules/.bin/tsx"),
    hint: "run: corepack pnpm install --frozen-lockfile",
  });
  checks.push({
    label: "Web dependencies installed",
    ok: dependencyExecutable("apps/web/node_modules/.bin/react-router"),
    hint: "run: corepack pnpm install --frozen-lockfile",
  });
  const composeVersion = probeCommand({
    command: "docker",
    args: ["compose", "version"],
    env: configuration.composeEnvironment,
  });
  checks.push({
    label: "Docker Compose CLI available",
    ok: composeVersion.ok,
    hint: composeVersion.detail,
  });
  const pnpmVersion = probeCommand({
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["--version"],
  });
  const pnpmVersionNumber = pnpmVersion.stdout?.split("\n").at(-1);
  checks.push({
    label: `pnpm ${pnpmVersionNumber || "unavailable"} (requires >=11.10.0)`,
    ok: pnpmVersion.ok && versionAtLeast(pnpmVersionNumber, [11, 10, 0]),
    hint: "run: corepack enable",
  });
  const containerTarget = inspectContainerTarget(
    configuration.composeEnvironment,
  );
  checks.push({
    label: `Container target is local (${containerTarget.source}: ${printableContainerEndpoint(containerTarget.endpoint)})`,
    ok: containerTarget.local,
    hint:
      containerTarget.detail ||
      "switch to a local Docker/Podman context before running development services",
  });
  const composeConfig = probeCommand(plan.composeConfig);
  checks.push({
    label: "Local Compose configuration valid",
    ok: composeConfig.ok,
    hint: composeConfig.detail,
  });
  const composeRuntime = containerTarget.local
    ? probeCommand(plan.composeRuntime)
    : {
        ok: false,
        detail: "skipped because the container target is not local",
      };
  checks.push({
    label: "Local Compose runtime reachable",
    ok: composeRuntime.ok,
    hint: composeRuntime.detail,
  });
  const apiPortProbe = await probePort(configuration.apiPort);
  checks.push({
    label: `API port ${configuration.apiPort} available`,
    ok: apiPortProbe.available,
    hint:
      apiPortProbe.code === "EADDRINUSE"
        ? "choose another port with --api-port or IMS_DEV_API_PORT"
        : portFailureHint(apiPortProbe, configuration.apiPort, "API"),
  });
  const webPortProbe = await probePort(configuration.webPort);
  checks.push({
    label: `Web port ${configuration.webPort} available`,
    ok: webPortProbe.available,
    hint:
      webPortProbe.code === "EADDRINUSE"
        ? "choose another port with --web-port or IMS_DEV_WEB_PORT"
        : portFailureHint(webPortProbe, configuration.webPort, "Web"),
  });

  for (const check of checks) {
    process.stdout.write(`[${check.ok ? "ok" : "fail"}] ${check.label}\n`);
    if (!check.ok && check.hint) {
      process.stdout.write(`       ${String(check.hint).split("\n")[0]}\n`);
    }
  }
  return checks.every((check) => check.ok);
}

function printPlan(configuration, plan) {
  process.stdout.write("[dev] Startup plan (no commands executed)\n");
  const commands = [
    ["Validate Compose", plan.composeConfig],
    [
      configuration.storageMode === "r2"
        ? "Start PostgreSQL"
        : "Start PostgreSQL and RustFS",
      plan.infrastructure,
    ],
    ["Wait for PostgreSQL", plan.postgresReady],
    ...(plan.rustfsInit ? [["Initialize RustFS bucket", plan.rustfsInit]] : []),
    ["Apply PostgreSQL migrations", plan.migrate],
    ["Start Hono API", plan.api],
    ["Start React Web", plan.web],
  ];
  for (const [label, specification] of commands) {
    process.stdout.write(
      `[dev] ${label}: ${printableCommand(specification)}\n`,
    );
  }
  process.stdout.write(`[dev] Web URL: ${configuration.webOrigin}\n`);
  process.stdout.write(`[dev] API URL: ${configuration.apiOrigin}\n`);
  if (configuration.storageMode === "r2") {
    process.stdout.write(`[dev] R2 test bucket: ${configuration.bucket}\n`);
    process.stdout.write(
      `[dev] R2 public URL: ${configuration.publicReadUrlBase}\n`,
    );
  }
}

export async function prepareDevelopmentEnvironment(
  configuration,
  plan,
  operations = { runCommand, waitForCommand, waitForUrl },
) {
  operations.runCommand(
    "Validating local Compose configuration",
    plan.composeConfig,
  );
  operations.runCommand(
    configuration.storageMode === "r2"
      ? "Starting PostgreSQL"
      : "Starting PostgreSQL and RustFS",
    plan.infrastructure,
  );
  await operations.waitForCommand("Waiting for PostgreSQL", plan.postgresReady);
  if (plan.rustfsInit) {
    process.stdout.write("[dev] Waiting for RustFS\n");
    await operations.waitForUrl(
      "RustFS",
      `${configuration.rustfsOrigin}/health`,
      undefined,
      60_000,
    );
    operations.runCommand(
      "Initializing the local RustFS bucket",
      plan.rustfsInit,
    );
  }
  operations.runCommand("Applying PostgreSQL migrations", plan.migrate);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const configuration = resolveDevelopmentConfiguration({ options });
  const plan = buildCommandPlan(configuration);

  if (options.dryRun) {
    printPlan(configuration, plan);
    return 0;
  }
  if (options.doctor) return (await doctor(configuration, plan)) ? 0 : 1;
  if (!supportedPlatforms.has(process.platform)) {
    throw new Error(
      `Platform ${process.platform} is unsupported by pnpm dev; use macOS, Linux, or WSL2`,
    );
  }
  const containerTarget = inspectContainerTarget(
    configuration.composeEnvironment,
  );
  assertLocalContainerTarget(containerTarget);
  if (options.down) {
    runCommand("Stopping local PostgreSQL and RustFS", plan.down);
    process.stdout.write("[dev] Local data volumes were preserved.\n");
    return 0;
  }

  if (!versionAtLeast(process.versions.node)) {
    throw new Error(
      `Node ${process.versions.node} is unsupported; use Node >=22.13.0 (see .nvmrc)`,
    );
  }
  for (const [label, relativePath] of [
    ["API", "apps/api/node_modules/.bin/tsx"],
    ["Web", "apps/web/node_modules/.bin/react-router"],
  ]) {
    if (!dependencyExecutable(relativePath)) {
      throw new Error(
        `${label} dependencies are missing; run corepack pnpm install --frozen-lockfile`,
      );
    }
  }
  for (const [label, port] of [
    ["API", configuration.apiPort],
    ["Web", configuration.webPort],
  ]) {
    const probe = await probePort(port);
    if (!probe.available) throw new Error(portFailureHint(probe, port, label));
  }

  await prepareDevelopmentEnvironment(configuration, plan);
  await supervise(configuration, plan);
  return process.exitCode || 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`[dev] ${error.message}\n`);
      process.exitCode = 1;
    });
}
