const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const scriptUrl = pathToFileURL(
  path.resolve(__dirname, "../scripts/development/dev-environment.mjs"),
).href;
const launcher = import(scriptUrl);

function assertIsolatedPlatformSecret(configuration) {
  const platformSecret = configuration.apiEnvironment.IMS_PLATFORM_JWT_SECRET;
  assert.equal(typeof platformSecret, "string");
  assert.equal(Buffer.byteLength(platformSecret, "utf8") >= 32, true);
  assert.notEqual(
    platformSecret,
    configuration.apiEnvironment.IMS_BACKOFFICE_JWT_SECRET,
  );
  assert.notEqual(platformSecret, "production-platform-secret");
}

const r2TestEnvironment = Object.freeze({
  IMS_OBJECT_STORAGE: "s3",
  IMS_S3_BUCKET: "imsweb-media-public-test",
  IMS_PUBLIC_READ_URL_BASE: "https://test.assets.example.com",
  IMS_S3_PUBLIC_READ_URL_BASE: "https://test.assets.example.com",
  IMS_S3_REGION: "auto",
  IMS_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  IMS_S3_FORCE_PATH_STYLE: "false",
  IMS_S3_PREFIX: "",
  IMS_S3_READ_URL_TTL_SECONDS: "300",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
});

test("development launcher parses defaults and explicit ports", async () => {
  const { parseArguments } = await launcher;

  assert.deepEqual(parseArguments([], {}), {
    apiPort: 3000,
    webPort: 5173,
    doctor: false,
    down: false,
    dryRun: false,
    help: false,
    r2: false,
  });
  assert.deepEqual(
    parseArguments(
      ["--api-port", "3100", "--web-port", "5180", "--dry-run"],
      {},
    ),
    {
      apiPort: 3100,
      webPort: 5180,
      doctor: false,
      down: false,
      dryRun: true,
      help: false,
      r2: false,
    },
  );
  assert.equal(
    parseArguments([], {
      IMS_DEV_API_PORT: "3200",
      IMS_DEV_WEB_PORT: "5190",
    }).apiPort,
    3200,
  );
  assert.equal(parseArguments(["--r2"], {}).r2, true);
});

test("development launcher rejects ambiguous or invalid arguments", async () => {
  const { parseArguments } = await launcher;

  assert.throws(() => parseArguments(["--doctor", "--down"], {}), /cannot/);
  assert.throws(() => parseArguments(["--api-port", "0"], {}), /between/);
  assert.throws(
    () => parseArguments(["--api-port", "4000", "--web-port", "4000"], {}),
    /must be different/,
  );
  assert.throws(() => parseArguments(["--unknown"], {}), /Unknown option/);
});

test("development configuration derives a fully local runtime", async () => {
  const { parseArguments, resolveDevelopmentConfiguration, repositoryRoot } =
    await launcher;
  const configuration = resolveDevelopmentConfiguration({
    environment: {
      PATH: "/test/bin",
      IMS_ENV_FILE: "/production/api.env",
      IMS_SUPER_ADMIN_USERNAME: "production-admin",
      IMS_PLATFORM_JWT_SECRET: "production-platform-secret",
      IMS_FUDABA_PUBLIC_READ_ENABLED: "true",
      IMS_FUDABA_WRITE_ENABLED: "true",
      IMS_FUDABA_MAP_ENABLED: "true",
      IMS_FUDABA_MAP_STYLE_URL: "https://production.invalid/style.json",
      DATABASE_URL: "postgresql://production.invalid/imsweb",
      AWS_SESSION_TOKEN: "production-session-token",
    },
    deployEnvironment: {
      IMS_POSTGRES_PORT: "55432",
      IMS_POSTGRES_DB: "ims/web",
      IMS_POSTGRES_USER: "dev user",
      IMS_POSTGRES_PASSWORD: "p@ss/word",
      IMS_RUSTFS_API_PORT: "9900",
      IMS_RUSTFS_ACCESS_KEY: "rustfs-user",
      IMS_RUSTFS_SECRET_KEY: "rustfs-password",
      IMS_RUSTFS_BUCKET: "imsweb-test",
    },
    options: parseArguments(["--api-port", "3100", "--web-port", "5180"], {}),
  });

  assert.equal(
    configuration.databaseUrl,
    "postgresql://dev%20user:p%40ss%2Fword@127.0.0.1:55432/ims%2Fweb",
  );
  assert.equal(configuration.apiEnvironment.NODE_ENV, "development");
  assert.equal(configuration.apiEnvironment.PATH, "/test/bin");
  assert.equal(configuration.apiEnvironment.IMS_ENV_FILE, "");
  assert.equal(
    "IMS_SUPER_ADMIN_USERNAME" in configuration.apiEnvironment,
    false,
  );
  assert.equal("AWS_SESSION_TOKEN" in configuration.apiEnvironment, false);
  assert.equal(configuration.apiEnvironment.IMS_PROJECT_ROOT, repositoryRoot);
  assert.equal("IMS_DATABASE" in configuration.apiEnvironment, false);
  assert.equal(configuration.apiEnvironment.IMS_OBJECT_STORAGE, "s3");
  assertIsolatedPlatformSecret(configuration);
  assert.equal(
    configuration.apiEnvironment.IMS_FUDABA_PUBLIC_READ_ENABLED,
    "false",
  );
  assert.equal(configuration.apiEnvironment.IMS_FUDABA_WRITE_ENABLED, "false");
  assert.equal(configuration.apiEnvironment.IMS_FUDABA_MAP_ENABLED, "false");
  assert.equal(configuration.apiEnvironment.IMS_FUDABA_MAP_STYLE_URL, "");
  assert.equal(
    configuration.apiEnvironment.IMS_S3_ENDPOINT,
    "http://127.0.0.1:9900",
  );
  assert.equal(
    configuration.apiEnvironment.IMS_PUBLIC_READ_URL_BASE,
    "http://127.0.0.1:9900/imsweb-test",
  );
  assert.equal(
    configuration.apiEnvironment.IMS_S3_PUBLIC_READ_URL_BASE,
    "http://127.0.0.1:9900/imsweb-test",
  );
  assert.equal(configuration.apiEnvironment.IMS_S3_PUBLIC_BUCKET, "");
  assert.equal(configuration.apiEnvironment.IMS_UPLOADS_DIR, "data/uploads");
  assert.equal("IMS_SITE_ORIGIN" in configuration.apiEnvironment, false);
  assert.equal(
    configuration.webEnvironment.IMS_API_ORIGIN,
    "http://127.0.0.1:3100",
  );
});

test("development configuration translates explicit Fudaba gates", async () => {
  const { parseArguments, resolveDevelopmentConfiguration } = await launcher;
  const environment = {
    IMS_DEV_FUDABA_PUBLIC_READ_ENABLED: " TRUE ",
    IMS_DEV_FUDABA_WRITE_ENABLED: "true",
    IMS_DEV_FUDABA_MAP_ENABLED: "true",
    IMS_DEV_FUDABA_MAP_STYLE_URL: " /maps/exchange-style.json ",
  };
  const configuration = resolveDevelopmentConfiguration({
    environment,
    deployEnvironment: {},
    options: parseArguments([], environment),
  });

  assert.equal(
    configuration.apiEnvironment.IMS_FUDABA_PUBLIC_READ_ENABLED,
    "true",
  );
  assert.equal(configuration.apiEnvironment.IMS_FUDABA_WRITE_ENABLED, "true");
  assert.equal(configuration.apiEnvironment.IMS_FUDABA_MAP_ENABLED, "true");
  assert.equal(
    configuration.apiEnvironment.IMS_FUDABA_MAP_STYLE_URL,
    "/maps/exchange-style.json",
  );
  for (const name of Object.keys(environment)) {
    assert.equal(name in configuration.apiEnvironment, false);
    assert.equal(name in configuration.webEnvironment, false);
  }
});

test("development configuration rejects unsafe Fudaba overrides", async () => {
  const { parseArguments, resolveDevelopmentConfiguration } = await launcher;
  const resolve = (environment) =>
    resolveDevelopmentConfiguration({
      environment,
      deployEnvironment: {},
      options: parseArguments([], environment),
    });

  for (const name of [
    "IMS_DEV_FUDABA_PUBLIC_READ_ENABLED",
    "IMS_DEV_FUDABA_WRITE_ENABLED",
    "IMS_DEV_FUDABA_MAP_ENABLED",
  ]) {
    assert.throws(() => resolve({ [name]: "yes" }), new RegExp(`${name} must`));
  }
  assert.throws(
    () => resolve({ IMS_DEV_FUDABA_MAP_ENABLED: "true" }),
    /IMS_DEV_FUDABA_MAP_STYLE_URL is required/,
  );
  for (const styleUrl of [
    "https://tiles.example.com/style.json",
    "//tiles.example.com/style.json",
    "/maps/exchange-style.json?token=secret",
    "/maps/exchange-style.json#fragment",
  ]) {
    assert.throws(
      () => resolve({ IMS_DEV_FUDABA_MAP_STYLE_URL: styleUrl }),
      /must be a same-origin absolute path/,
    );
  }
});

test("development configuration isolates an explicit R2 test runtime", async () => {
  const { parseArguments, resolveDevelopmentConfiguration } = await launcher;
  const configuration = resolveDevelopmentConfiguration({
    environment: {
      PATH: "/test/bin",
      IMS_SUPER_ADMIN_USERNAME: "production-admin",
      IMS_BACKOFFICE_JWT_SECRET: "production-backoffice-secret",
      IMS_PLATFORM_JWT_SECRET: "production-platform-secret",
      IMS_JWT_SECRET: "production-secret",
      DATABASE_URL: "postgresql://production.invalid/imsweb",
    },
    deployEnvironment: {},
    options: parseArguments(
      ["--r2", "--api-port", "3100", "--web-port", "5180"],
      {},
    ),
    r2Environment: r2TestEnvironment,
  });

  assert.equal(configuration.storageMode, "r2");
  assert.equal(configuration.bucket, "imsweb-media-public-test");
  assert.equal(
    configuration.apiEnvironment.IMS_PUBLIC_READ_URL_BASE,
    "https://test.assets.example.com",
  );
  assert.equal(configuration.apiEnvironment.IMS_S3_REGION, "auto");
  assert.equal(
    configuration.apiEnvironment.IMS_S3_ENDPOINT,
    "https://account.r2.cloudflarestorage.com",
  );
  assert.equal(configuration.apiEnvironment.IMS_S3_FORCE_PATH_STYLE, "false");
  assert.equal(
    configuration.apiEnvironment.AWS_ACCESS_KEY_ID,
    "test-access-key",
  );
  assert.equal(
    configuration.apiEnvironment.IMS_BACKOFFICE_JWT_SECRET,
    "imsweb-local-development-secret",
  );
  assertIsolatedPlatformSecret(configuration);
  assert.equal("IMS_JWT_SECRET" in configuration.apiEnvironment, false);
  assert.equal(
    configuration.apiEnvironment.DATABASE_URL.includes("127.0.0.1"),
    true,
  );
  assert.equal(
    "IMS_SUPER_ADMIN_USERNAME" in configuration.apiEnvironment,
    false,
  );
  assert.equal(configuration.composeArguments.includes("local-storage"), false);
});

test("R2 hot reload rejects a bucket not marked as test", async () => {
  const { parseArguments, resolveDevelopmentConfiguration } = await launcher;

  assert.throws(
    () =>
      resolveDevelopmentConfiguration({
        environment: {},
        deployEnvironment: {},
        options: parseArguments(["--r2"], {}),
        r2Environment: {
          ...r2TestEnvironment,
          IMS_S3_BUCKET: "imsweb-media-public-prod",
        },
      }),
    /not explicitly marked as test/,
  );
});

test("development command plan orders local infrastructure before hot reload", async () => {
  const { buildCommandPlan, parseArguments, resolveDevelopmentConfiguration } =
    await launcher;
  const configuration = resolveDevelopmentConfiguration({
    environment: {},
    deployEnvironment: {},
    options: parseArguments([], {}),
  });
  const plan = buildCommandPlan(configuration);

  assert.deepEqual(plan.infrastructure.args.slice(-4), [
    "up",
    "-d",
    "postgres",
    "rustfs",
  ]);
  assert.deepEqual(plan.composeRuntime.args.slice(-2), ["ps", "--quiet"]);
  assert.equal(plan.infrastructure.env, configuration.composeEnvironment);
  assert.equal(plan.down.env, configuration.composeEnvironment);
  assert.deepEqual(plan.rustfsInit.args.slice(-4), [
    "run",
    "--rm",
    "--no-deps",
    "rustfs-init",
  ]);
  assert.deepEqual(plan.migrate.args, [
    "--filter",
    "@imsweb/api",
    "run",
    "migration:postgresql",
  ]);
  assert.deepEqual(plan.api.args, [
    "--filter",
    "@imsweb/api",
    "run",
    "dev",
  ]);
  assert.deepEqual(plan.web.args, [
    "--filter",
    "@imsweb/web",
    "exec",
    "react-router",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ]);
  assert.equal(plan.web.args.includes("--"), false);
  assert.deepEqual(plan.down.args.slice(-4), [
    "stop",
    "rustfs-init",
    "rustfs",
    "postgres",
  ]);
  assert.equal(plan.down.args.includes("--volumes"), false);
  assert.equal(
    JSON.stringify(plan).includes("imsweb-local-development-secret"),
    true,
  );
  assert.equal(
    [...plan.infrastructure.args, ...plan.migrate.args]
      .join(" ")
      .includes("imsweb-local-development-secret"),
    false,
  );
});

test("R2 command plan starts PostgreSQL without RustFS", async () => {
  const { buildCommandPlan, parseArguments, resolveDevelopmentConfiguration } =
    await launcher;
  const configuration = resolveDevelopmentConfiguration({
    environment: {},
    deployEnvironment: {},
    options: parseArguments(["--r2"], {}),
    r2Environment: r2TestEnvironment,
  });
  const plan = buildCommandPlan(configuration);

  assert.deepEqual(plan.infrastructure.args.slice(-3), [
    "up",
    "-d",
    "postgres",
  ]);
  assert.equal(plan.infrastructure.args.includes("rustfs"), false);
  assert.equal(plan.rustfsInit, undefined);
  assert.deepEqual(plan.down.args.slice(-2), ["stop", "postgres"]);
});

test("development launcher enforces the repository Node baseline", async () => {
  const { versionAtLeast } = await launcher;

  assert.equal(versionAtLeast("22.12.9"), false);
  assert.equal(versionAtLeast("22.13.0"), true);
  assert.equal(versionAtLeast("24.0.0"), true);
  assert.equal(versionAtLeast("not-a-version"), false);
});

test("development launcher recognizes only local container endpoints", async () => {
  const { isLocalContainerEndpoint } = await launcher;

  assert.equal(isLocalContainerEndpoint("unix:///var/run/docker.sock"), true);
  assert.equal(
    isLocalContainerEndpoint("npipe:////./pipe/docker_engine"),
    true,
  );
  assert.equal(isLocalContainerEndpoint("tcp://127.0.0.1:2375"), true);
  assert.equal(
    isLocalContainerEndpoint("ssh://core@localhost/run/podman.sock"),
    true,
  );
  assert.equal(
    isLocalContainerEndpoint("ssh://deploy@prod.example.com/run/docker.sock"),
    false,
  );
  assert.equal(isLocalContainerEndpoint("tcp://10.0.0.8:2375"), false);
  assert.equal(isLocalContainerEndpoint(""), false);
});

test("development launcher resolves Docker and Podman targets safely", async () => {
  const { inspectContainerTarget } = await launcher;
  const remote = inspectContainerTarget(
    {
      DOCKER_HOST: "ssh://deploy@prod.example.com/run/docker.sock",
    },
    () => ({ ok: true, stdout: "Docker version 28.0.0" }),
  );
  assert.equal(remote.local, false);
  assert.equal(remote.source, "DOCKER_HOST");

  const remoteContext = inspectContainerTarget({}, (specification) => {
    if (specification.args[0] === "--version") {
      return { ok: true, stdout: "Docker version 28.0.0" };
    }
    if (specification.args[0] === "context") {
      return {
        ok: true,
        stdout: JSON.stringify("ssh://deploy@prod.example.com/run/docker.sock"),
      };
    }
    throw new Error("Podman fallback must not run for a resolved context");
  });
  assert.equal(remoteContext.local, false);
  assert.equal(remoteContext.source, "Docker context");

  const contextOverridesHost = inspectContainerTarget(
    {
      DOCKER_CONTEXT: "production",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
    () => ({
      ok: true,
      stdout: JSON.stringify("ssh://deploy@prod.example.com/run/docker.sock"),
    }),
  );
  assert.equal(contextOverridesHost.local, false);
  assert.equal(contextOverridesHost.source, "Docker context production");

  const podmanWrapperConflict = inspectContainerTarget(
    {
      DOCKER_HOST: "unix:///var/run/docker.sock",
      CONTAINER_HOST: "ssh://deploy@prod.example.com/run/podman.sock",
    },
    (specification) => {
      assert.equal(specification.args[0], "--version");
      return { ok: true, stdout: "podman version 5.8.5" };
    },
  );
  assert.equal(podmanWrapperConflict.local, false);
  assert.equal(podmanWrapperConflict.source, "CONTAINER_HOST");

  const dockerContextOverridesPodmanHost = inspectContainerTarget(
    { CONTAINER_HOST: "unix:///run/user/501/podman.sock" },
    () => ({
      ok: true,
      stdout: JSON.stringify("ssh://deploy@prod.example.com/run/docker.sock"),
    }),
  );
  assert.equal(dockerContextOverridesPodmanHost.local, false);
  assert.equal(dockerContextOverridesPodmanHost.source, "Docker context");

  const unresolvedDockerContext = inspectContainerTarget(
    { CONTAINER_HOST: "unix:///run/user/501/podman.sock" },
    (specification) =>
      specification.args[0] === "--version"
        ? { ok: true, stdout: "Docker version 28.0.0" }
        : { ok: true, stdout: "" },
  );
  assert.equal(unresolvedDockerContext.local, false);
  assert.equal(unresolvedDockerContext.source, "Docker context");

  const podmanHost = inspectContainerTarget(
    { CONTAINER_HOST: "unix:///run/user/501/podman.sock" },
    (specification) =>
      specification.args[0] === "--version"
        ? { ok: true, stdout: "podman version 5.8.5" }
        : { ok: true, stdout: "" },
  );
  assert.equal(podmanHost.local, true);
  assert.equal(podmanHost.source, "CONTAINER_HOST");

  const podman = inspectContainerTarget({}, (specification) => {
    if (specification.args[0] === "context") {
      return { ok: true, stdout: "" };
    }
    if (specification.args[0] === "--version") {
      return { ok: true, stdout: "podman version 5.8.5" };
    }
    return {
      ok: true,
      stdout: JSON.stringify([
        {
          Name: "podman-machine-default",
          URI: "ssh://core@127.0.0.1:49951/run/podman/podman.sock",
          Default: true,
        },
      ]),
    };
  });
  assert.equal(podman.local, true);
  assert.equal(podman.source, "Podman default connection");
});

test("development preparation waits for dependencies before migration", async () => {
  const {
    buildCommandPlan,
    parseArguments,
    prepareDevelopmentEnvironment,
    resolveDevelopmentConfiguration,
  } = await launcher;
  const configuration = resolveDevelopmentConfiguration({
    environment: {},
    deployEnvironment: {},
    options: parseArguments([], {}),
  });
  const plan = buildCommandPlan(configuration);
  const events = [];

  await prepareDevelopmentEnvironment(configuration, plan, {
    runCommand(label) {
      events.push(label);
    },
    async waitForCommand(label) {
      events.push(label);
    },
    async waitForUrl(label, url) {
      events.push(`${label}:${url}`);
    },
  });

  assert.deepEqual(events, [
    "Validating local Compose configuration",
    "Starting PostgreSQL and RustFS",
    "Waiting for PostgreSQL",
    "RustFS:http://127.0.0.1:9000/health",
    "Initializing the local RustFS bucket",
    "Applying PostgreSQL migrations",
  ]);
});

test("R2 development preparation skips RustFS", async () => {
  const {
    buildCommandPlan,
    parseArguments,
    prepareDevelopmentEnvironment,
    resolveDevelopmentConfiguration,
  } = await launcher;
  const configuration = resolveDevelopmentConfiguration({
    environment: {},
    deployEnvironment: {},
    options: parseArguments(["--r2"], {}),
    r2Environment: r2TestEnvironment,
  });
  const events = [];

  await prepareDevelopmentEnvironment(
    configuration,
    buildCommandPlan(configuration),
    {
      runCommand(label) {
        events.push(label);
      },
      async waitForCommand(label) {
        events.push(label);
      },
      async waitForUrl() {
        events.push("unexpected RustFS wait");
      },
    },
  );

  assert.deepEqual(events, [
    "Validating local Compose configuration",
    "Starting PostgreSQL",
    "Waiting for PostgreSQL",
    "Applying PostgreSQL migrations",
  ]);
});

test("development preparation stops before migration when readiness fails", async () => {
  const {
    buildCommandPlan,
    parseArguments,
    prepareDevelopmentEnvironment,
    resolveDevelopmentConfiguration,
  } = await launcher;
  const configuration = resolveDevelopmentConfiguration({
    environment: {},
    deployEnvironment: {},
    options: parseArguments([], {}),
  });
  const events = [];

  await assert.rejects(
    prepareDevelopmentEnvironment(
      configuration,
      buildCommandPlan(configuration),
      {
        runCommand(label) {
          events.push(label);
        },
        async waitForCommand(label) {
          events.push(label);
          throw new Error("database unavailable");
        },
        async waitForUrl() {
          events.push("unexpected RustFS wait");
        },
      },
    ),
    /database unavailable/,
  );
  assert.equal(events.includes("Applying PostgreSQL migrations"), false);
  assert.equal(events.includes("unexpected RustFS wait"), false);
});

test("development launcher help and dry-run have no runtime prerequisites", () => {
  const scriptPath = path.resolve(
    __dirname,
    "../scripts/development/dev-environment.mjs",
  );
  const help = execFileSync(process.execPath, [scriptPath, "--help"], {
    encoding: "utf8",
  });
  const dryRun = execFileSync(
    process.execPath,
    [scriptPath, "--dry-run", "--api-port", "3100", "--web-port", "5180"],
    { encoding: "utf8" },
  );

  assert.match(help, /pnpm run dev:doctor/);
  assert.match(dryRun, /Startup plan \(no commands executed\)/);
  assert.match(dryRun, /Web URL: http:\/\/127\.0\.0\.1:5180/);
  assert.match(dryRun, /API URL: http:\/\/127\.0\.0\.1:3100/);
  assert.doesNotMatch(dryRun, /imsweb-local-development-secret/);
});

test("development launcher refuses remote targets before Compose writes", () => {
  const scriptPath = path.resolve(
    __dirname,
    "../scripts/development/dev-environment.mjs",
  );
  const result = spawnSync(process.execPath, [scriptPath, "--down"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_HOST: "ssh://deploy@prod.example.com/run/docker.sock",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Refusing to modify a non-local container target/,
  );
});
