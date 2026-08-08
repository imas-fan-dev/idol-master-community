import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BOUNDARY_SCRIPT = PROJECT_ROOT / "scripts/check-workspace-boundaries.mjs"


class WorkspaceBoundaryTests(unittest.TestCase):
    def make_fixture(self, root: Path) -> None:
        root_package = json.loads(
            (PROJECT_ROOT / "package.json").read_text(encoding="utf-8")
        )
        files = {
            "package.json": json.dumps(root_package),
            "pnpm-workspace.yaml": "packages:\n  - apps/api\n  - apps/web\n",
            ".npmrc": "registry=https://registry.npmjs.org/\n",
            ".nvmrc": "22.13.0\n",
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "apps/api/.env.example": "IMS_BACKOFFICE_JWT_SECRET=\n",
            "apps/web/.env.example": "IMS_API_ORIGIN=http://127.0.0.1:3000\n",
            "deploy/.env.example": "IMS_POSTGRES_IMAGE=postgres:18.4-alpine\n",
            "apps/api/package.json": (
                PROJECT_ROOT / "apps/api/package.json"
            ).read_text(encoding="utf-8"),
            "apps/web/package.json": (
                PROJECT_ROOT / "apps/web/package.json"
            ).read_text(encoding="utf-8"),
            "apps/api/src/app.ts": "export {};\n",
            "apps/api/src/main.ts": "export {};\n",
            "data/.gitignore": "*\n!.gitignore\n",
            "deploy/compose.yaml": "services: {}\n",
        }
        for relative_path, content in files.items():
            destination = root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding="utf-8")
        script_path = root / "scripts/check-workspace-boundaries.mjs"
        script_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(BOUNDARY_SCRIPT, script_path)

    def run_fixture(self, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", "scripts/check-workspace-boundaries.mjs"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        )

    def test_two_workspace_fixture_passes(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            result = self.run_fixture(root)

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_root_dev_dependency_outside_tooling_allowlist_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            package_path = root / "package.json"
            package = json.loads(package_path.read_text(encoding="utf-8"))
            package.setdefault("devDependencies", {})["unexpected-tool"] = "1.0.0"
            package_path.write_text(json.dumps(package), encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "root aggregator must not declare devDependencies: unexpected-tool",
            result.stderr,
        )

    def test_legacy_workspace_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            legacy_file = root / "apps/legacy/package.json"
            legacy_file.parent.mkdir(parents=True)
            legacy_file.write_text('{"name":"@imsweb/legacy"}\n', encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/legacy", result.stderr)
        self.assertIn("separate private repository", result.stderr)

    def test_compose_nginx_service_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / "deploy/compose.yaml").write_text(
                "services:\n  nginx:\n    image: nginx:alpine\n",
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not provision Nginx", result.stderr)

    def test_api_compose_build_is_allowed(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / "deploy/compose.yaml").write_text(
                "services:\n"
                "  api:\n"
                "    build:\n"
                "      context: ..\n"
                "      dockerfile: apps/api/Dockerfile\n",
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_host_nginx_directory_is_allowed(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            nginx_config = root / "deploy/nginx/imsweb.conf.example"
            nginx_config.parent.mkdir(parents=True)
            nginx_config.write_text("server {}\n", encoding="utf-8")
            result = self.run_fixture(root)

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_api_source_cannot_restore_server_subdirectory(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            nested_source = root / "apps/api/src/server/old-entry.ts"
            nested_source.parent.mkdir(parents=True)
            nested_source.write_text("export {};\n", encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/api/src/server", result.stderr)

    def test_api_cannot_restore_retired_worker_runtime(self):
        for relative_path, reported_path in [
            ("apps/api/src/worker.ts", "apps/api/src/worker.ts"),
            (
                "apps/api/src/infra/media/cloudflare-images/image-processor.ts",
                "apps/api/src/infra/media/cloudflare-images",
            ),
            ("apps/api/tests/worker/runtime.test.ts", "apps/api/tests/worker"),
            ("apps/api/wrangler.jsonc", "apps/api/wrangler.jsonc"),
        ]:
            with self.subTest(relative_path=relative_path):
                with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
                    root = Path(temporary)
                    self.make_fixture(root)
                    candidate = root / relative_path
                    candidate.parent.mkdir(parents=True, exist_ok=True)
                    candidate.write_text("export {};\n", encoding="utf-8")
                    result = self.run_fixture(root)

                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reported_path, result.stderr)

    def test_root_environment_template_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / ".env.example").write_text("MIXED_CONFIG=true\n", encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("environment templates must be owned", result.stderr)

    def test_web_must_be_covered_by_default_lifecycle(self):
        for script_name, replacement in {
            "build": "pnpm run build:api",
            "check": "pnpm run check:api",
            "test": "pnpm run test:api",
        }.items():
            with self.subTest(script_name=script_name):
                with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
                    root = Path(temporary)
                    self.make_fixture(root)
                    package_path = root / "package.json"
                    package = json.loads(package_path.read_text(encoding="utf-8"))
                    package["scripts"][script_name] = replacement
                    package_path.write_text(json.dumps(package), encoding="utf-8")
                    result = self.run_fixture(root)

                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    f"default command {script_name} never resolves to @imsweb/web",
                    result.stderr,
                )

    def test_package_script_surfaces_remain_bounded_without_deprecated_aliases(self):
        root_scripts = json.loads(
            (PROJECT_ROOT / "package.json").read_text(encoding="utf-8")
        )["scripts"]
        api_scripts = json.loads(
            (PROJECT_ROOT / "apps/api/package.json").read_text(encoding="utf-8")
        )["scripts"]
        web_scripts = json.loads(
            (PROJECT_ROOT / "apps/web/package.json").read_text(encoding="utf-8")
        )["scripts"]

        self.assertLessEqual(len(root_scripts), 50)
        self.assertLessEqual(len(api_scripts), 35)
        self.assertLessEqual(len(web_scripts), 13)
        self.assertTrue(
            {
                "build",
                "check",
                "test",
                "dev",
                "start",
            }.issubset(root_scripts)
        )
        for deprecated in (
            "build:api",
            "build:server",
            "start:node",
            "test:all",
            "test:fast",
            "user:add",
            "password:hash",
        ):
            with self.subTest(package="root", deprecated=deprecated):
                self.assertNotIn(deprecated, root_scripts)
        for deprecated in (
            "build:server",
            "dev:node",
            "start:node",
            "test:fast",
            "typecheck:server",
            "user:add",
            "password:hash",
        ):
            with self.subTest(package="api", deprecated=deprecated):
                self.assertNotIn(deprecated, api_scripts)

    def test_nested_alias_cannot_hide_legacy_filter(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            package_path = root / "package.json"
            package = json.loads(package_path.read_text(encoding="utf-8"))
            package["scripts"]["test"] = "pnpm run apparently:safe"
            package["scripts"]["apparently:safe"] = "pnpm run hidden:target"
            package["scripts"]["hidden:target"] = (
                "pnpm --filter=@imsweb/legacy run test"
            )
            package_path.write_text(json.dumps(package), encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("@imsweb/legacy", result.stderr)

    def test_non_official_lockfile_tarball_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / "pnpm-lock.yaml").write_text(
                "lockfileVersion: '9.0'\npackages:\n  fixture@1.0.0:\n"
                "    resolution: {tarball: https://registry.npmmirror.com/fixture.tgz}\n",
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-official tarball", result.stderr)

    def test_npmmirror_registry_is_allowed(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / ".npmrc").write_text(
                "registry=https://registry.npmmirror.com/\n"
                "disturl=https://npmmirror.com/mirrors/node\n",
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unapproved_registry_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / ".npmrc").write_text(
                "registry=https://packages.example.test/\n",
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("every configured registry must be one of", result.stderr)

    def test_nested_web_repository_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / "apps/web/.git").mkdir()
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/web/.git", result.stderr)

    def test_web_features_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            feature = root / "apps/web/app/features/home/home-page.tsx"
            feature.parent.mkdir(parents=True)
            feature.write_text("export default function Home() {}\n", encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("app/features", result.stderr)
        self.assertIn("app/pages route hierarchy", result.stderr)

    def test_web_shared_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            shared_module = root / "apps/web/app/shared/legacy.ts"
            shared_module.parent.mkdir(parents=True)
            shared_module.write_text("export {}\n", encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/web/app/shared", result.stderr)
        self.assertIn("shared modules must live under app/lib", result.stderr)

    def test_web_lib_api_request_and_public_facade_import_are_allowed(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            endpoint = root / "apps/web/app/lib/api/endpoints/home.ts"
            endpoint.parent.mkdir(parents=True)
            endpoint.write_text(
                'export const getHome = () => fetch("/api/home")\n',
                encoding="utf-8",
            )
            page = root / "apps/web/app/pages/home/home-page.tsx"
            page.parent.mkdir(parents=True)
            page.write_text(
                'export { getHome } from "~/lib/api"\n',
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_web_page_cannot_construct_api_request(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            page = root / "apps/web/app/pages/home/home-page.tsx"
            page.parent.mkdir(parents=True)
            page.write_text(
                'export const loadHome = () => fetch("/api/news")\n',
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/web/app/pages/home/home-page.tsx", result.stderr)
        self.assertIn("requests must be defined in app/lib/api", result.stderr)

    def test_web_page_cannot_own_api_module(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            page_api = root / "apps/web/app/pages/home/api.ts"
            page_api.parent.mkdir(parents=True)
            page_api.write_text(
                'export { getHomeNews } from "~/lib/api"\n',
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/web/app/pages/home/api.ts", result.stderr)
        self.assertIn("page-local API modules are forbidden", result.stderr)

    def test_web_source_cannot_import_api_internals(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            page = root / "apps/web/app/pages/home/home-page.tsx"
            page.parent.mkdir(parents=True)
            page.write_text(
                'export { apiClient } from "~/lib/api/client"\n',
                encoding="utf-8",
            )
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/web/app/pages/home/home-page.tsx", result.stderr)
        self.assertIn("import the public ~/lib/api facade", result.stderr)

    def test_web_source_tests_must_use_central_unit_hierarchy(self):
        for relative_path in [
            "apps/web/app/pages/home/home-page.test.tsx",
            "apps/web/app/components/shared/site-header.test.tsx",
            "apps/web/app/i18n/language.test.ts",
            "apps/web/app/lib/api/api.test.ts",
        ]:
            with self.subTest(relative_path=relative_path):
                with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
                    root = Path(temporary)
                    self.make_fixture(root)
                    source_test = root / relative_path
                    source_test.parent.mkdir(parents=True)
                    source_test.write_text("export {}\n", encoding="utf-8")
                    result = self.run_fixture(root)

                self.assertNotEqual(result.returncode, 0)
                self.assertIn(relative_path, result.stderr)
                self.assertIn("tests/unit", result.stderr)

    def test_python_is_rejected_from_api_source(self):
        with tempfile.TemporaryDirectory(prefix="ims-boundary-") as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            python_file = root / "apps/api/src/tools/import.py"
            python_file.parent.mkdir(parents=True)
            python_file.write_text("pass\n", encoding="utf-8")
            result = self.run_fixture(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python is forbidden", result.stderr)


if __name__ == "__main__":
    unittest.main()
