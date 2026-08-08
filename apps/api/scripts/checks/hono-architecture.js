'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.join(root, 'src');
const domainRoot = path.join(sourceRoot, 'domains');
const infraRoot = path.join(sourceRoot, 'infra');
const portRoot = path.join(sourceRoot, 'ports');
const routingRoot = path.join(sourceRoot, 'routing');
const sharedRoot = path.join(sourceRoot, 'shared');
const utilsRoot = path.join(sourceRoot, 'utils');
const failures = [];

function filesUnder(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return filesUnder(absolute);
        return /\.tsx?$/.test(entry.name) ? [absolute] : [];
    });
}

const infraCategories = new Set([
    'cache',
    'db',
    'email',
    'http',
    'media',
    'oss',
    'security'
]);
const infraMiddleware = new Map([
    ['cache', new Set(['filesystem', 'memory', 'sql'])],
    ['db', new Set(['postgresql', 'repositories', 'sql'])],
    ['email', new Set(['cloudflare'])],
    ['http', new Set(['busboy', 'filesystem'])],
    ['media', new Set(['sharp'])],
    ['oss', new Set(['filesystem', 's3'])],
    ['security', new Set(['bcrypt', 'hmac'])]
]);
for (const entry of fs.readdirSync(infraRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !infraCategories.has(entry.name)) {
        failures.push(`src/infra/${entry.name}: infrastructure must use a capability directory`);
        continue;
    }
    const categoryRoot = path.join(infraRoot, entry.name);
    for (const middleware of fs.readdirSync(categoryRoot, { withFileTypes: true })) {
        if (!middleware.isDirectory() || !infraMiddleware.get(entry.name).has(middleware.name)) {
            failures.push(
                `src/infra/${entry.name}/${middleware.name}: infrastructure must use a concrete middleware directory`
            );
            continue;
        }
        for (const implementation of fs.readdirSync(path.join(categoryRoot, middleware.name), {
            withFileTypes: true
        })) {
            if (
                !implementation.isFile() ||
                !/^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/.test(implementation.name) ||
                /^(?:adapter|implementation|index|service)\.ts$/.test(implementation.name)
            ) {
                failures.push(
                    `src/infra/${entry.name}/${middleware.name}/${implementation.name}: ` +
                    'middleware files must be split and named by business responsibility'
                );
            }
        }
    }
}

const databaseLayout = new Map([
    ['postgresql', ['connection.ts', 'schema-strategy.ts']],
    ['repositories', [
        'core-repository.ts',
        'fudaba-repository.ts',
        'platform-account-repository.ts',
        'story-repository.ts'
    ]],
    ['sql', ['database.ts', 'query.ts']]
]);
for (const [directory, requiredFiles] of databaseLayout) {
    for (const requiredFile of requiredFiles) {
        const file = path.join(infraRoot, 'db', directory, requiredFile);
        if (!fs.existsSync(file)) {
            failures.push(`src/infra/db/${directory}/${requiredFile}: missing database adapter responsibility`);
        }
    }
}

const portContracts = new Map([
    ['cache.ts', ['IdempotencyStore', 'RateLimiter', 'CacheServices']],
    ['email.ts', ['PlatformEmailSender', 'EmailServices']],
    ['http.ts', ['StaticAssets', 'UploadParser', 'HttpServices']],
    ['media.ts', ['ImageProcessor', 'MediaServices']],
    ['object-storage.ts', ['ObjectStorage', 'CompensationService', 'ObjectStorageServices']],
    ['repositories.ts', [
        'BackofficeAuthRepository',
        'PlatformAccountRepository',
        'FudabaRepository',
        'AuditRepository',
        'NewsRepository',
        'EventRepository',
        'NamecardRepository',
        'ReactionRepository',
        'SitePackageRepository',
        'StoryRepository',
        'RepositoryServices'
    ]],
    ['runtime-services.ts', ['RuntimeServices', 'NodeRuntimeServices']],
    ['security.ts', [
        'BackofficeTokenService',
        'PasswordVerifier',
        'SecurityServices'
    ]]
]);
for (const [name, contracts] of portContracts) {
    const file = path.join(portRoot, name);
    if (!fs.existsSync(file)) {
        failures.push(`src/ports/${name}: missing application port`);
        continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    for (const contract of contracts) {
        if (!source.includes(`interface ${contract}`)) {
            failures.push(`src/ports/${name}: missing ${contract} contract`);
        }
    }
}
for (const entry of fs.readdirSync(portRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !portContracts.has(entry.name)) {
        failures.push(`src/ports/${entry.name}: ports must be explicit flat capability contracts`);
    }
}
const legacyAdapterRoot = path.join(sourceRoot, 'adapters');
if (fs.existsSync(legacyAdapterRoot) && filesUnder(legacyAdapterRoot).length) {
    failures.push('src/adapters: implementations must be classified under src/infra');
}

if (fs.existsSync(sharedRoot)) {
    failures.push('src/shared: shared is forbidden; move code to its responsibility module');
}

const utilsCategories = new Set(['crypto', 'http', 'media', 'storage', 'validation']);
for (const entry of fs.readdirSync(utilsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !utilsCategories.has(entry.name)) {
        failures.push(`src/utils/${entry.name}: utilities must use a responsibility directory`);
        continue;
    }
    for (const implementation of fs.readdirSync(path.join(utilsRoot, entry.name), {
        withFileTypes: true
    })) {
        if (
            !implementation.isFile() ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/.test(implementation.name) ||
            /^(?:helpers?|index|utils?)\.ts$/.test(implementation.name)
        ) {
            failures.push(
                `src/utils/${entry.name}/${implementation.name}: ` +
                'utility files must be flat and named by responsibility'
            );
        }
    }
}
for (const entry of fs.readdirSync(routingRoot, { withFileTypes: true })) {
    if (
        !entry.isFile() ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/.test(entry.name) ||
        /^(?:helpers?|index|utils?)\.ts$/.test(entry.name)
    ) {
        failures.push(`src/routing/${entry.name}: routing files must be named by responsibility`);
    }
}

const relativeInternalImport = /\b(?:from\s*|import\s*(?:\(\s*)?)(['"])\.{1,2}\//;
const concreteMiddlewareImport = /\b(?:from\s*|import\s*(?:\(\s*)?)(['"])(?:@aws-sdk\/|@prisma\/client|@\/generated\/prisma|bcrypt(?:js)?|busboy|pg|sharp)/;
const concretePlatformType = /\b(?:D1Database|D1PreparedStatement|ImagesBinding|PrismaClient|R2Bucket)\b/;
for (const file of filesUnder(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    if (relativeInternalImport.test(source)) {
        failures.push(`${path.relative(root, file)}: internal imports must use the @ root alias`);
    }
    const relative = path.relative(sourceRoot, file).replace(/\\/g, '/');
    if (relative.startsWith('infra/')) {
        const [, category, middleware] = relative.split('/');
        for (const match of source.matchAll(
            /['"]@\/infra\/([a-z-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)/g
        )) {
            const internalSqlDependency = match[1] === 'db' &&
                match[2] === 'sql' && match[3] === 'database';
            const repositorySqlQuery = category === 'db' && middleware === 'repositories' &&
                match[1] === 'db' && match[2] === 'sql' && match[3] === 'query';
            if ((match[1] !== category || match[2] !== middleware) &&
                !internalSqlDependency && !repositorySqlQuery) {
                failures.push(
                    `${path.relative(root, file)}: infrastructure adapter must not depend on another adapter: ` +
                    `${match[1]}/${match[2]}`
                );
            }
        }
        if (/['"]@\/(?:domains|runtime)\//.test(source)) {
            failures.push(`${path.relative(root, file)}: infrastructure must not depend on domains or runtime`);
        }
    }
    if (
        !relative.startsWith('infra/') &&
        !relative.startsWith('runtime/')
    ) {
        for (const match of source.matchAll(/['"](@\/infra\/[^'"]+)['"]/g)) {
            failures.push(
                `${path.relative(root, file)}: application code must depend on ports, not infrastructure: ${match[1]}`
            );
        }
        if (concreteMiddlewareImport.test(source) || concretePlatformType.test(source)) {
            failures.push(
                `${path.relative(root, file)}: application code must depend on ports instead of middleware types`
            );
        }
    }
    if (relative.startsWith('ports/') && /['"]@\/(?:config|domains|infra|runtime)\//.test(source)) {
        failures.push(`${path.relative(root, file)}: ports must not depend on outer layers`);
    }
    if (relative !== 'infra/db/postgresql/connection.ts' && /\bPoolClient\b/.test(source)) {
        failures.push(`${path.relative(root, file)}: concrete database type bypasses SqlDatabase`);
    }
}

const sqlPortSource = fs.readFileSync(path.join(sourceRoot, 'infra/db/sql/database.ts'), 'utf8');
for (const contract of ['interface SqlDatabase', 'interface SqlStatement', 'transaction<', 'batch<']) {
    if (!sqlPortSource.includes(contract)) {
        failures.push(`src/infra/db/sql/database.ts: missing ${contract} contract`);
    }
}

const serverConfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.server.json'), 'utf8'));
if (JSON.stringify(serverConfig.compilerOptions?.paths?.['@/*']) !== JSON.stringify(['./src/*'])) {
    failures.push('tsconfig.server.json: @/* must map to ./src/*');
}
const bundleTsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
if (bundleTsconfig.extends !== './tsconfig.server.json') {
    failures.push('tsconfig.json: default API configuration must inherit tsconfig.server.json');
}

const forbiddenDomainPatterns = [
    [/\bfrom\s+['"](?:express|sharp|multer|node:fs|fs)['"]/, 'forbidden runtime import'],
    [/\brequire\(\s*['"](?:express|sharp|multer|node:fs|fs)['"]\s*\)/, 'forbidden runtime require'],
    [/\b(?:from\s*|import\s*(?:\(\s*)?)['"]@\/runtime\//, 'direct runtime import'],
    [/\bprocess\.env\b/, 'direct environment access'],
    [/\b(?:Flask|Pillow)\b/, 'Python web/image runtime reference']
];

for (const file of filesUnder(domainRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [pattern, label] of forbiddenDomainPatterns) {
        if (pattern.test(source)) failures.push(`${path.relative(root, file)}: ${label}`);
    }
}

for (const domain of fs.readdirSync(domainRoot, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    const directory = path.join(domainRoot, domain.name);
    const routeFiles = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /(?:^|-)routes\.tsx?$/.test(entry.name));
    if (!routeFiles.length) continue;

    const handlersRoot = path.join(directory, 'handlers');
    if (!fs.existsSync(handlersRoot)) {
        failures.push(`src/domains/${domain.name}/handlers: route handlers must be split by action`);
        continue;
    }
    const handlerFiles = fs.readdirSync(handlersRoot, { withFileTypes: true });
    for (const handler of handlerFiles) {
        if (
            !handler.isFile() ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*\.tsx?$/.test(handler.name) ||
            handler.name === 'index.ts' || handler.name === 'index.tsx'
        ) {
            failures.push(
                `src/domains/${domain.name}/handlers/${handler.name}: ` +
                'handler modules must be flat kebab-case files'
            );
            continue;
        }
        const source = fs.readFileSync(path.join(handlersRoot, handler.name), 'utf8');
        if (!/export (?:async )?function (?:handle|createHandle)[A-Z]/.test(source)) {
            failures.push(
                `src/domains/${domain.name}/handlers/${handler.name}: ` +
                'handler module must explicitly export a handle* or createHandle* function'
            );
        }
    }
    for (const route of routeFiles) {
        const routePath = path.join(directory, route.name);
        const source = fs.readFileSync(routePath, 'utf8');
        if (!source.includes(`/domains/${domain.name}/handlers/`)) {
            failures.push(
                `${path.relative(root, routePath)}: route module must import split handlers`
            );
        }
        if (source.includes('=>')) {
            failures.push(
                `${path.relative(root, routePath)}: route module must not contain inline handlers`
            );
        }
    }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const dependency of ['express', 'flask', 'cookie-parser', 'cors', 'helmet', 'multer', 'jsonwebtoken', 'jose']) {
    if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency]) {
        failures.push(`package.json: legacy dependency remains: ${dependency}`);
    }
}

for (const legacyRuntime of [
    'public/app.py',
    'public/gunicorn_conf.py',
    'public/requirements.txt',
    'public/templates',
    'public/uwsgi.ini',
    'public/uwsgi.pid',
    'tests/test_flask_security.py'
]) {
    if (fs.existsSync(path.join(root, legacyRuntime))) {
        failures.push(`${legacyRuntime}: removed Flask runtime surface has returned`);
    }
}

const appSource = fs.readFileSync(path.join(sourceRoot, 'app.ts'), 'utf8');
if (!appSource.includes('export function createHonoApp') || !appSource.includes("c.set('services'")) {
    failures.push('src/app.ts: request-scoped service resolution contract is missing');
}
const mainSource = fs.readFileSync(path.join(sourceRoot, 'main.ts'), 'utf8');
for (const exportName of ['honoApp', 'app', 'startServer', 'closeDatabase']) {
    if (!new RegExp(`export (?:const|function|async function) ${exportName}\\b`).test(mainSource)) {
        failures.push(`src/main.ts: missing ${exportName} export`);
    }
}

const nodeServicesSource = fs.readFileSync(path.join(sourceRoot, 'runtime/node-services.ts'), 'utf8');
for (const implementation of [
    'FilesystemIdempotencyStore',
    'MemoryRateLimiter',
    'PostgresConnection',
    'SqlFudabaRepository',
    'FilesystemObjectStorage',
    'S3ObjectStorage',
    'StreamingUploadParser',
    'NodeStaticAssets',
    'SharpImageProcessor',
    'BcryptPasswordVerifier'
]) {
    if (!nodeServicesSource.includes(implementation)) {
        failures.push(`src/runtime/node-services.ts: missing ${implementation} composition`);
    }
}
if (failures.length) throw new Error(`Hono architecture check failed:\n${failures.join('\n')}`);
process.stdout.write(`Hono architecture check passed: ${filesUnder(domainRoot).length} domain modules\n`);
