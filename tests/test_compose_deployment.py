from pathlib import Path
import re
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
COMPOSE_PATH = PROJECT_ROOT / "deploy/compose.yaml"
API_DOCKERFILE_PATH = PROJECT_ROOT / "apps/api/Dockerfile"


class ComposeDeploymentTests(unittest.TestCase):
    def test_compose_owns_local_data_services_and_api(self):
        compose = COMPOSE_PATH.read_text(encoding="utf-8")
        services_source = compose.split("\nvolumes:\n", maxsplit=1)[0]
        services = re.findall(r"^  ([a-z0-9][a-z0-9-]*):$", services_source, re.MULTILINE)

        self.assertEqual(services, ["postgres", "rustfs", "rustfs-init", "api"])
        self.assertIn("image: ${IMS_POSTGRES_IMAGE:-postgres:18.4-alpine}", compose)
        self.assertIn(
            "image: ${IMS_RUSTFS_IMAGE:-rustfs/rustfs:1.0.0-beta.12}",
            compose,
        )
        self.assertIn("image: ${IMS_S3_CLIENT_IMAGE:-minio/mc:", compose)
        self.assertEqual(compose.count("      - local-storage"), 2)
        self.assertIn("postgresql-data:/var/lib/postgresql", compose)
        self.assertIn("rustfs-data:/data", compose)
        self.assertIn("image: ${IMS_API_IMAGE:-imsweb-api:local}", compose)
        self.assertIn("dockerfile: apps/api/Dockerfile", compose)
        self.assertIn("DEBIAN_MIRROR_BASE: ${IMS_DEBIAN_MIRROR_BASE:-", compose)
        self.assertIn(
            "NPM_REGISTRY: ${IMS_NPM_REGISTRY:-https://registry.npmmirror.com}",
            compose,
        )
        self.assertIn(
            "NODE_HEADERS_MIRROR: ${IMS_NODE_HEADERS_MIRROR:-https://npmmirror.com/mirrors/node}",
            compose,
        )
        self.assertIn('127.0.0.1:${IMS_API_PORT:-3000}:3000', compose)
        self.assertIn(
            "IMS_BACKOFFICE_JWT_SECRET: ${IMS_BACKOFFICE_JWT_SECRET-}",
            compose,
        )
        self.assertNotIn(
            "IMS_BACKOFFICE_JWT_SECRET:-imsweb-local-development-secret",
            compose,
        )
        self.assertIn("condition: service_completed_successfully", compose)
        self.assertIn("required: false", compose)
        self.assertIn("node apps/api/scripts/migration/postgres-migrations.js", compose)
        self.assertIn("api-data:/app/data", compose)
        self.assertNotRegex(compose, r"(?i)nginx")
        self.assertNotIn("network_mode: host", compose)

    def test_api_accepts_external_s3_and_postgresql_pool_configuration(self):
        compose = COMPOSE_PATH.read_text(encoding="utf-8")

        for token in (
            "IMS_OBJECT_STORAGE: ${IMS_OBJECT_STORAGE:-s3}",
            "IMS_S3_BUCKET: ${IMS_S3_BUCKET:-imsweb-media-local}",
            "IMS_PUBLIC_READ_URL_BASE: ${IMS_PUBLIC_READ_URL_BASE:-",
            "IMS_S3_REGION: ${IMS_S3_REGION:-us-east-1}",
            "IMS_S3_ENDPOINT: ${IMS_S3_ENDPOINT:-http://rustfs:9000}",
            "IMS_S3_FORCE_PATH_STYLE: ${IMS_S3_FORCE_PATH_STYLE:-true}",
            "IMS_S3_PREFIX: ${IMS_S3_PREFIX-}",
            "AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:-imsweb-local}",
            "AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-imsweb-local-password}",
            "IMS_PG_POOL_MAX: ${IMS_PG_POOL_MAX:-10}",
        ):
            self.assertIn(token, compose)

    def test_api_image_is_a_non_root_production_build(self):
        dockerfile = API_DOCKERFILE_PATH.read_text(encoding="utf-8")
        dependency_build_stage = dockerfile.split(
            "FROM pnpm-base AS build", maxsplit=1
        )[0]

        self.assertIn("ARG NODE_VERSION=24.18.0", dockerfile)
        self.assertEqual(dockerfile.count("ARG NPM_REGISTRY="), 2)
        self.assertEqual(dockerfile.count("ENV COREPACK_NPM_REGISTRY="), 2)
        self.assertIn(
            "ENV npm_config_disturl=${NODE_HEADERS_MIRROR}",
            dependency_build_stage,
        )
        self.assertIn("pnpm run build", dockerfile)
        self.assertIn(
            "pnpm install --offline --frozen-lockfile --prod --filter @imsweb/api...",
            dockerfile,
        )
        self.assertEqual(dockerfile.count("ENV HUSKY=0"), 2)
        self.assertEqual(
            dockerfile.count("COPY .husky/install.mjs .husky/install.mjs"),
            2,
        )
        self.assertNotIn("--ignore-scripts", dockerfile)
        self.assertNotIn("rebuild sqlite3", dockerfile)
        self.assertIn("COPY --from=build /app/apps/api/dist apps/api/dist", dockerfile)
        self.assertIn("USER node", dockerfile)
        self.assertIn('CMD ["node", "apps/api/dist/server/main.js"]', dockerfile)

    def test_rustfs_creates_one_public_bucket_with_a_protected_prefix(self):
        compose = COMPOSE_PATH.read_text(encoding="utf-8")
        policy = (PROJECT_ROOT / "deploy/rustfs-public-policy.json").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("IMS_RUSTFS_PUBLIC_BUCKET", compose)
        self.assertNotRegex(compose, r"(?m)^\s+sed\s")
        self.assertIn('mc anonymous set-json /tmp/policy.json', compose)
        self.assertIn('mc version enable "local/$${IMS_RUSTFS_BUCKET}"', compose)
        self.assertIn("/__protected/*", policy)
        self.assertIn("/*/__protected/*", policy)

    def test_only_current_compose_is_present(self):
        self.assertTrue(COMPOSE_PATH.is_file())
        self.assertEqual(
            sorted(path.name for path in (PROJECT_ROOT / "deploy").glob("compose*.yaml")),
            ["compose.yaml"],
        )
        self.assertTrue((PROJECT_ROOT / "deploy/nginx/imsweb.conf.example").is_file())
        self.assertTrue((PROJECT_ROOT / "deploy/nginx/README.md").is_file())
        self.assertFalse((PROJECT_ROOT / "compose.yaml").exists())
        self.assertFalse((PROJECT_ROOT / "compose.emergency.yaml").exists())
        self.assertFalse((PROJECT_ROOT / "apps/legacy").exists())

    def test_host_nginx_config_keeps_application_and_rustfs_private(self):
        config = (
            PROJECT_ROOT / "deploy/nginx/imsweb.conf.example"
        ).read_text(encoding="utf-8")

        self.assertIn("server 127.0.0.1:3000;", config)
        self.assertIn("server 127.0.0.1:9000;", config)
        self.assertNotIn("127.0.0.1:9001", config)
        self.assertIn("server_name __IMS_APP_DOMAIN__;", config)
        self.assertIn("server_name __IMS_S3_DOMAIN__;", config)
        self.assertIn("proxy_pass http://imsweb_node;", config)
        self.assertIn("proxy_pass http://imsweb_rustfs;", config)
        self.assertIn("proxy_set_header X-Forwarded-For $remote_addr;", config)
        self.assertIn("proxy_set_header Host $http_host;", config)
        self.assertIn("proxy_request_buffering off;", config)
        self.assertEqual(config.count("client_max_body_size 64m;"), 2)
        self.assertNotIn("client_max_body_size 0;", config)


if __name__ == "__main__":
    unittest.main()
