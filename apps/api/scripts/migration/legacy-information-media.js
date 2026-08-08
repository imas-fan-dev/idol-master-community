'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
    defaultInformationIndex,
    parseInformationIndex,
    serializeInformationIndex
} = require('../../src/domains/information/data.ts');
const { contentTypeForPath } = require('../../src/utils/http/content-type.ts');
const {
    INFORMATION_INDEX_OBJECT_KEY,
    publicMediaObjectKey
} = require('../../src/utils/storage/business-object-keys.ts');

const MIGRATED_AT = '2026-07-24T00:00:00.000Z';
const LEGACY_INFORMATION_CARDS = [
    {
        source: 'assets/images/hiro2026/xzg2026.png',
        id: 'legacy-hiro2026',
        category: 'activity',
        contentType: 'external',
        title: '篠泽广研讨会',
        image: '/uploads/information/original/xzg2026.png',
        link: '/sites/hiro2026',
        updatedAt: MIGRATED_AT
    },
    {
        source: 'assets/images/Information/guangzhou2026.png',
        id: 'legacy-guangzhou2026',
        category: 'fan',
        contentType: 'external',
        title: '广州偶像大师 ONLY',
        image: '/uploads/information/original/guangzhou2026.png',
        link: 'https://show.bilibili.com/platform/detail.html?id=1002732&from=pc_search',
        updatedAt: '2026-07-24T18:44:41.927Z'
    },
    {
        source: 'assets/images/Information/ife2.png',
        id: 'legacy-ife02',
        category: 'fan',
        contentType: 'external',
        title: 'IFE02',
        image: '/uploads/information/original/ife2.png',
        link: 'https://www.bilibili.com/opus/1202632935749976099',
        updatedAt: MIGRATED_AT
    },
    {
        source: 'assets/images/Information/chengduonly1st.jpg',
        id: 'legacy-chengdu2026',
        category: 'fan',
        contentType: 'external',
        title: '成都偶像大师 ONLY',
        image: '/uploads/information/original/chengduonly1st.jpg',
        link: 'http://xhslink.com/o/3MHP3lo3cZZ',
        updatedAt: MIGRATED_AT
    },
    {
        source: 'assets/images/Information/2026hangzhouonly.png',
        id: 'legacy-hangzhou2026',
        category: 'fan',
        contentType: 'external',
        title: '杭州偶像大师 ONLY',
        image: '/uploads/information/original/2026hangzhouonly.png',
        link: 'http://xhslink.com/o/8ax2OXQuXK8',
        updatedAt: MIGRATED_AT
    },
    {
        source: 'assets/images/Information/hunan2026.png',
        id: 'legacy-hunan2026',
        category: 'fan',
        contentType: 'external',
        title: '湖南偶像大师 ONLY',
        image: '/uploads/information/original/hunan2026.png',
        link: 'https://www.bilibili.com/video/BV1kKEb6iE9F/',
        updatedAt: MIGRATED_AT
    }
];

function sha256(body) {
    return crypto.createHash('sha256').update(body).digest('hex');
}

function parseArguments(argv, environment = process.env) {
    const projectRoot = path.resolve(__dirname, '../../../..');
    const options = {
        source: path.resolve(environment.IMS_INFORMATION_SOURCE_DIR ||
            path.join(projectRoot, 'data/import/public')),
        manifest: path.join(
            projectRoot,
            'data/migration/information-media-migration.json'
        ),
        apply: false,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        const next = () => {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
            return value;
        };
        if (argument === '--source') options.source = path.resolve(next());
        else if (argument === '--manifest') options.manifest = path.resolve(next());
        else if (argument === '--apply') options.apply = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    options.manifest = path.resolve(options.manifest);
    return options;
}

function helpText() {
    return [
        'Usage: pnpm run media:information:sync -- [options]',
        '',
        'Moves the six historical home Information cards and images into object storage.',
        'The command is read-only unless --apply is provided.',
        '',
        'Options:',
        '  --source <directory>   Private historical export root (default: data/import/public)',
        '  --manifest <file>      JSON audit report path',
        '  --apply                Write images and the Information index, then verify them',
        '  --help                 Show this help',
        '',
        'Requires PostgreSQL and IMS_OBJECT_STORAGE=s3 with the S3/MinIO variables.'
    ].join('\n');
}

function storedCard(seed) {
    const { source: _source, ...card } = seed;
    return card;
}

function nextInformationIndex(current) {
    const seedById = new Map(LEGACY_INFORMATION_CARDS.map((seed) => [seed.id, seed]));
    let convertedCards = 0;
    const cards = current.cards.map((card) => {
        const seed = seedById.get(card.id);
        if (!seed) return card;
        const migrateImage = card.image.startsWith('/assets/images/');
        const migrateHiroLink = card.id === 'legacy-hiro2026' &&
            card.link === '/hiro2026.html';
        if (!migrateImage && !migrateHiroLink) return card;
        convertedCards += 1;
        return {
            ...card,
            image: migrateImage ? seed.image : card.image,
            link: migrateHiroLink ? seed.link : card.link,
            updatedAt: MIGRATED_AT
        };
    });
    const existingIds = new Set(cards.map((card) => card.id));
    const addedCards = LEGACY_INFORMATION_CARDS
        .filter((seed) => !existingIds.has(seed.id))
        .map(storedCard);
    const assets = [...current.assets];
    for (const seed of LEGACY_INFORMATION_CARDS) {
        if (!assets.includes(seed.image)) assets.push(seed.image);
    }
    return {
        index: { version: 1, cards: [...cards, ...addedCards], assets },
        addedCards: addedCards.length,
        convertedCards,
        addedAssets: assets.length - current.assets.length
    };
}

async function syncLegacyInformation(sourceRoot, storage, apply) {
    const absoluteSource = path.resolve(sourceRoot);
    const currentObject = await storage.get(INFORMATION_INDEX_OBJECT_KEY);
    const current = currentObject
        ? parseInformationIndex(currentObject.body)
        : defaultInformationIndex();
    const plan = nextInformationIndex(current);
    const assetResults = [];

    for (const seed of LEGACY_INFORMATION_CARDS) {
        const sourcePath = path.join(absoluteSource, seed.source);
        const body = await fs.readFile(sourcePath);
        const digest = sha256(body);
        const key = publicMediaObjectKey(seed.image);
        const existing = await storage.get(key);
        const matches = existing !== null && existing.size === body.byteLength &&
            sha256(existing.body) === digest;
        let status = 'unchanged';
        if (!matches && !apply) status = existing ? 'would-replace' : 'would-upload';
        if (!matches && apply) {
            status = existing ? 'replaced' : 'uploaded';
            await storage.put(key, body, {
                contentType: contentTypeForPath(sourcePath),
                sha256: digest,
                metadata: { source: 'legacy-information-migration' }
            });
        }
        if (apply || matches) {
            const verified = await storage.get(key);
            if (!verified || verified.size !== body.byteLength || sha256(verified.body) !== digest) {
                throw new Error(`Information asset verification failed: ${key}`);
            }
        }
        assetResults.push({
            id: seed.id,
            sourcePath,
            key,
            bytes: body.byteLength,
            sha256: digest,
            status
        });
    }

    const indexChanged = plan.addedCards > 0 || plan.convertedCards > 0 || plan.addedAssets > 0;
    let indexStatus = indexChanged ? 'would-write' : 'unchanged';
    if (apply && indexChanged) {
        if (!storage.putIfUnchanged) {
            throw new Error('Information migration requires conditional object writes');
        }
        const stored = await storage.putIfUnchanged(
            INFORMATION_INDEX_OBJECT_KEY,
            currentObject?.etag || null,
            serializeInformationIndex(plan.index),
            { contentType: 'application/json; charset=utf-8' }
        );
        if (!stored) throw new Error('Information index changed during migration; retry');
        indexStatus = currentObject ? 'updated' : 'created';
    }

    if (apply || !indexChanged) {
        const verified = await storage.get(INFORMATION_INDEX_OBJECT_KEY);
        if (!verified) throw new Error('Information index verification failed');
        const parsed = parseInformationIndex(verified.body);
        for (const seed of LEGACY_INFORMATION_CARDS) {
            const card = parsed.cards.find((candidate) => candidate.id === seed.id);
            if (!card || !card.image.startsWith('/uploads/information/') ||
                !parsed.assets.includes(card.image)) {
                throw new Error(`Information card verification failed: ${seed.id}`);
            }
        }
    }

    return {
        sourceRoot: absoluteSource,
        apply,
        indexStatus,
        cardsAdded: plan.addedCards,
        cardsConverted: plan.convertedCards,
        assetsAddedToIndex: plan.addedAssets,
        assets: assetResults,
        summary: {
            fileCount: assetResults.length,
            totalBytes: assetResults.reduce((total, asset) => total + asset.bytes, 0),
            unchanged: assetResults.filter((asset) => asset.status === 'unchanged').length,
            wouldUpload: assetResults.filter((asset) => asset.status === 'would-upload').length,
            wouldReplace: assetResults.filter((asset) => asset.status === 'would-replace').length,
            uploaded: assetResults.filter((asset) => asset.status === 'uploaded').length,
            replaced: assetResults.filter((asset) => asset.status === 'replaced').length
        }
    };
}

async function writeManifest(target, report) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        ...report
    }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${helpText()}\n`);
        return;
    }
    require('../../src/config/load-environment.ts');
    const { parseNodeObjectStorageConfig } = require('../../src/config/object-storage.ts');
    if (parseNodeObjectStorageConfig().type !== 's3') {
        throw new Error('Information media sync requires IMS_OBJECT_STORAGE=s3');
    }
    const { closeNodeServices, resolveNodeServices } = require('../../src/runtime/node-services.ts');
    try {
        const services = await resolveNodeServices();
        const report = await syncLegacyInformation(options.source, services.storage, options.apply);
        await writeManifest(options.manifest, report);
        process.stdout.write(`${JSON.stringify({
            manifest: options.manifest,
            apply: report.apply,
            indexStatus: report.indexStatus,
            cardsAdded: report.cardsAdded,
            cardsConverted: report.cardsConverted,
            assetsAddedToIndex: report.assetsAddedToIndex,
            ...report.summary
        }, null, 2)}\n`);
    } finally {
        await closeNodeServices();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    LEGACY_INFORMATION_CARDS,
    helpText,
    nextInformationIndex,
    parseArguments,
    syncLegacyInformation
};
