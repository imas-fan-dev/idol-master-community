import json
from pathlib import Path
import re
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUNBOOK = PROJECT_ROOT / "docs/operations-runbook.md"
DATABASE_CONFIGURATION = PROJECT_ROOT / "docs/database-configuration.md"
OBJECT_STORAGE = PROJECT_ROOT / "docs/object-storage.md"
AI_DEVELOPMENT_ENVIRONMENT = PROJECT_ROOT / "docs/ai-development-environment.md"
API_ENVIRONMENT = PROJECT_ROOT / "apps/api/.env.example"
WEB_ENVIRONMENT = PROJECT_ROOT / "apps/web/.env.example"
DEPLOY_ENVIRONMENT = PROJECT_ROOT / "deploy/.env.example"
PNPM_WORKSPACE = PROJECT_ROOT / "pnpm-workspace.yaml"
PRODUCER_MAP_MIGRATION = PROJECT_ROOT / "docs/producer-map-online-migration.md"
PRODUCER_MAP_SQL = (
    PROJECT_ROOT / "deploy/migrations/producer-map-r2-control-plane.sql"
)


class OperationsDocumentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runbook = RUNBOOK.read_text(encoding="utf-8")
        cls.database_configuration = DATABASE_CONFIGURATION.read_text(encoding="utf-8")
        cls.object_storage = OBJECT_STORAGE.read_text(encoding="utf-8")
        cls.ai_guide = AI_DEVELOPMENT_ENVIRONMENT.read_text(encoding="utf-8")
        cls.producer_map_migration = PRODUCER_MAP_MIGRATION.read_text(encoding="utf-8")
        cls.producer_map_sql = PRODUCER_MAP_SQL.read_text(encoding="utf-8")

    def test_database_configuration_covers_postgresql_runtime_and_readiness(self):
        for token in (
            "DATABASE_URL",
            "一个 PostgreSQL 物理数据库",
            "IMS_PG_POOL_MAX",
            "migration:postgresql",
            "Hono Node",
            "自动读取 `apps/api/.env`",
            "/api/health/live",
            "/api/health/ready",
        ):
            self.assertIn(token, self.database_configuration)

        for readme in (
            PROJECT_ROOT / "README.md",
            PROJECT_ROOT / "apps/api/README.md",
        ):
            self.assertIn("database-configuration.md", readme.read_text(encoding="utf-8"))

    def test_ai_development_environment_is_executable_and_linked(self):
        for token in (
            "pnpm install --frozen-lockfile",
            "pnpm run dev:doctor",
            "pnpm dev",
            "pnpm run dev:down",
            "PostgreSQL",
            "RustFS",
            "自动读取 `apps/api/.env`",
            "pnpm run dev:postgresql:up",
            "pnpm run dev:rustfs:up",
            "pnpm run dev:node",
            "pnpm run dev:web",
            "curl --fail",
            "git status --short",
            "deploy/compose.yaml",
            "WSL2",
            "远程 context",
        ):
            self.assertIn(token, self.ai_guide)

        for document in (PROJECT_ROOT / "AGENTS.md", PROJECT_ROOT / "README.md"):
            self.assertIn(
                "docs/ai-development-environment.md",
                document.read_text(encoding="utf-8"),
            )

    def test_root_development_launcher_is_the_documented_default(self):
        package = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = package["scripts"]

        self.assertEqual(package["packageManager"], "pnpm@11.10.0")
        self.assertIn(
            "verifyDepsBeforeRun: warn",
            PNPM_WORKSPACE.read_text(encoding="utf-8"),
        )
        self.assertEqual(scripts["dev"], "node scripts/development/dev-environment.mjs")
        self.assertEqual(
            scripts["dev:r2"],
            "node scripts/development/dev-environment.mjs --r2",
        )
        self.assertEqual(
            scripts["dev:doctor"],
            "node scripts/development/dev-environment.mjs --doctor",
        )
        self.assertEqual(
            scripts["dev:down"],
            "node scripts/development/dev-environment.mjs --down",
        )
        self.assertIn(
            "tests/development-environment.test.js", scripts["test:infra"]
        )
        self.assertIn(
            "scripts/development/dev-environment.mjs", scripts["check:root"]
        )
        launcher = (
            PROJECT_ROOT / "scripts/development/dev-environment.mjs"
        ).read_text(encoding="utf-8")
        self.assertIn("inspectContainerTarget", launcher)
        self.assertIn("Refusing to modify a non-local container target", launcher)
        self.assertIn('IMS_ENV_FILE: ""', launcher)
        self.assertIn("R2 hot reload refuses a bucket", launcher)

        for document in (
            PROJECT_ROOT / "README.md",
            PROJECT_ROOT / "CONTRIBUTING.md",
            PROJECT_ROOT / "apps/api/README.md",
            PROJECT_ROOT / "apps/web/README.md",
            AI_DEVELOPMENT_ENVIRONMENT,
        ):
            with self.subTest(document=document):
                self.assertIn("pnpm dev", document.read_text(encoding="utf-8"))

    def test_api_development_command_hot_reloads_source_and_environment(self):
        package = json.loads(
            (PROJECT_ROOT / "apps/api/package.json").read_text(encoding="utf-8")
        )
        command = package["scripts"]["dev"]
        self.assertIn("tsx watch", command)
        self.assertIn("--include .env", command)
        migration_command = package["scripts"]["migration:postgresql"]
        self.assertIn("--env-file-if-exists=.env", migration_command)

    def test_local_r2_compose_entrypoint_uses_api_environment_without_minio(self):
        package = json.loads(
            (PROJECT_ROOT / "package.json").read_text(encoding="utf-8")
        )
        scripts = package["scripts"]

        for name in ("dev:api:r2:config", "dev:api:r2:up"):
            with self.subTest(name=name):
                command = scripts[name]
                self.assertIn("--env-file apps/api/.env", command)
                self.assertNotIn("--profile local-storage", command)

        for token in (
            "pnpm run dev:api:r2:config",
            "pnpm run dev:api:r2:up",
            "不启用或依赖 RustFS",
            "`auto` region",
        ):
            self.assertIn(token, self.ai_guide)

    def test_environment_templates_are_owned_by_runtime_surfaces(self):
        self.assertFalse((PROJECT_ROOT / ".env.example").exists())
        api_environment = API_ENVIRONMENT.read_text(encoding="utf-8")
        web_environment = WEB_ENVIRONMENT.read_text(encoding="utf-8")
        deploy_environment = DEPLOY_ENVIRONMENT.read_text(encoding="utf-8")

        for token in (
            "IMS_BACKOFFICE_JWT_SECRET",
            "IMS_JWT_SECRET",
            "IMS_SUPER_ADMIN_USERNAME",
            "IMS_OBJECT_STORAGE",
        ):
            self.assertIn(token, api_environment)
        self.assertNotIn("IMS_DATABASE", api_environment)
        self.assertIn("IMS_OBJECT_STORAGE=s3", api_environment)
        self.assertIn("DATABASE_URL=", api_environment)
        for token in ("IMS_API_ORIGIN", "E2E_BASE_URL"):
            self.assertIn(token, web_environment)
        for token in (
            "COMPOSE_PROFILES=local-storage",
            "IMS_POSTGRES_IMAGE",
            "IMS_RUSTFS_IMAGE",
            "IMS_RUSTFS_BUCKET",
            "IMS_S3_ENDPOINT",
            "IMS_PUBLIC_READ_URL_BASE",
            "AWS_ACCESS_KEY_ID",
        ):
            self.assertIn(token, deploy_environment)

        self.assertNotIn("IMS_NGINX_IMAGE", api_environment)
        self.assertNotIn("IMS_NGINX_IMAGE", deploy_environment)
        self.assertNotIn("IMS_NODE_UPSTREAM", deploy_environment)
        self.assertNotIn("IMS_BACKOFFICE_JWT_SECRET", web_environment)
        self.assertNotIn("IMS_JWT_SECRET", web_environment)
        self.assertNotIn("IMS_LEGACY", deploy_environment)

    def test_node_s3_storage_is_documented(self):
        for token in (
            "IMS_OBJECT_STORAGE",
            "IMS_S3_BUCKET",
            "IMS_PUBLIC_READ_URL_BASE",
            "IMS_S3_REGION",
            "IMS_S3_ENDPOINT",
            "IMS_S3_FORCE_PATH_STYLE",
            "IMS_S3_PREFIX",
            "IMS_S3_READ_URL_TTL_SECONDS",
            "AWS_ACCESS_KEY_ID",
            "GetObject",
            "PutObject",
            "DeleteObject",
            "不会自动搬迁",
            "migration:public-objects",
            "migration:single-bucket",
            "__protected",
            "Worker",
            "D1",
        ):
            self.assertIn(token, self.object_storage)

    def test_release_runbook_uses_complete_atomic_artifacts(self):
        package = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn("migration:release:activate", package["scripts"])
        self.assertIn("migration:release:rollback", package["scripts"])
        for token in (
            "migration:release:activate",
            "migration:release:rollback",
            "host-installed `node_modules`",
            "dist/client",
            "dist/node-client",
            "dist/server",
            "client-manifest.json",
            "/srv/ims/current",
            "pg_dump --format=custom",
            "数据库与媒体必须在同一停写窗口",
        ):
            self.assertIn(token, self.runbook)

    def test_public_docs_do_not_reference_removed_workspace(self):
        documents = [
            PROJECT_ROOT / "README.md",
            PROJECT_ROOT / "CONTRIBUTING.md",
            PROJECT_ROOT / "AGENTS.md",
            RUNBOOK,
            DATABASE_CONFIGURATION,
            OBJECT_STORAGE,
            AI_DEVELOPMENT_ENVIRONMENT,
        ]
        for document in documents:
            with self.subTest(document=document):
                self.assertNotIn("apps/legacy", document.read_text(encoding="utf-8"))

    def test_public_docs_keep_nginx_out_of_compose(self):
        documents = [
            PROJECT_ROOT / "README.md",
            PROJECT_ROOT / "apps/api/README.md",
            RUNBOOK,
            AI_DEVELOPMENT_ENVIRONMENT,
        ]
        for document in documents:
            with self.subTest(document=document):
                content = document.read_text(encoding="utf-8")
                self.assertNotIn("ops:nginx", content)

        package = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertFalse(any(name.startswith("ops:nginx") for name in package["scripts"]))
        compose = (PROJECT_ROOT / "deploy/compose.yaml").read_text(encoding="utf-8")
        self.assertNotRegex(compose, r"(?i)nginx")
        self.assertIn("deploy/nginx/", self.runbook)

    def test_producer_map_online_migration_is_guarded_and_complete(self):
        root_package = json.loads(
            (PROJECT_ROOT / "package.json").read_text(encoding="utf-8")
        )
        api_package = json.loads(
            (PROJECT_ROOT / "apps/api/package.json").read_text(encoding="utf-8")
        )
        self.assertIn("test:r2:producer-map", root_package["scripts"])
        r2_command = api_package["scripts"]["test:r2:producer-map"]
        self.assertIn("--require-r2", r2_command)
        self.assertIn("--expect-bucket imsweb-media-public-prod", r2_command)
        self.assertIn("--expect-empty-prefix", r2_command)
        self.assertNotIn("--apply", r2_command)

        rows = re.findall(
            r"^\s+\('community/producer-map/[^\n]+$",
            self.producer_map_sql,
            re.MULTILINE,
        )
        self.assertEqual(len(rows), 44)
        self.assertEqual(sum("/assets/community-" in row for row in rows), 9)
        self.assertEqual(sum("/assets/region-" in row for row in rows), 34)
        self.assertEqual(sum("/config.json'" in row for row in rows), 1)

        for token in (
            "0009_s3_public_storage_scope",
            "pg_advisory_xact_lock",
            "RAISE EXCEPTION",
            "ON CONFLICT (object_id) DO NOTHING",
            "ON CONFLICT (id) DO NOTHING",
            "ON CONFLICT (logical_key) DO NOTHING",
            "storage_scope = 'public'",
            "<> 7529245",
            "COMMIT;",
        ):
            self.assertIn(token, self.producer_map_sql)

        for token in (
            "imsweb-media-public-prod",
            "test -z \"${IMS_S3_PREFIX:-}\"",
            "pg_dump --format=custom",
            "producer-map-r2-control-plane.sql",
            "pnpm run test:r2:producer-map",
            "参数层禁止 `--apply`",
            "configStatus=unchanged",
            "objects.unchanged=43",
            "不要追加 `--apply`",
            "禁止只删数据库或只删 R2",
        ):
            self.assertIn(token, self.producer_map_migration)


if __name__ == "__main__":
    unittest.main()
