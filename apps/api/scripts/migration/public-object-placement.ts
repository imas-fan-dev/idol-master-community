import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNodeObjectStorageConfig } from '@/config/object-storage';
import type { NodeRuntimeServices } from '@/ports/runtime-services';
import { createNodeServices } from '@/runtime/node-services';

interface Options {
    apply: boolean;
    concurrency: number;
    report: string;
}

interface PlacementEntry {
    key: string;
    result: 'already-public' | 'missing' | 'moved' | 'would-move';
}

const projectRoot = path.resolve(__dirname, '../../../..');

function positiveInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64) {
        throw new Error(`${name} must be an integer between 1 and 64`);
    }
    return parsed;
}

export function parsePublicObjectPlacementArguments(
    argv: string[],
    environment: NodeJS.ProcessEnv = process.env
): Options {
    const config = parseNodeObjectStorageConfig(environment);
    if (config.type !== 's3' || !config.publicReadUrlBase) {
        throw new Error('IMS_PUBLIC_READ_URL_BASE is required');
    }
    let apply = false;
    let concurrency = 16;
    let report = path.join(
        projectRoot,
        'data/migration/public-object-placement-dry-run.json'
    );
    let confirmedBucket: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--apply') {
            apply = true;
            report = path.join(projectRoot, 'data/migration/public-object-placement.json');
        } else if (argument === '--report') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error('--report requires a file');
            report = path.resolve(projectRoot, value);
        } else if (argument === '--concurrency') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) {
                throw new Error('--concurrency requires a value');
            }
            concurrency = positiveInteger(value, '--concurrency');
        } else if (argument === '--confirm-bucket') {
            confirmedBucket = argv[++index];
        } else if (argument === '--help' || argument === '-h') {
            console.log([
                'Usage: pnpm run migration:public-objects -- [options]',
                '',
                'Dry-runs every readable ready object by default.',
                '',
                'Options:',
                '  --apply',
                '  --confirm-bucket <bucket>',
                '  --concurrency <1..64>',
                '  --report <file>',
                '  --help'
            ].join('\n'));
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (apply && confirmedBucket !== config.bucket) {
        throw new Error(
            'Apply requires --confirm-bucket ' + config.bucket
        );
    }
    return { apply, concurrency, report };
}

async function closeServices(services: NodeRuntimeServices): Promise<void> {
    await Promise.allSettled([
        services.storage.close?.(),
        services.story.close?.(),
        (services.backofficeAuth as { close?: () => Promise<void> }).close?.()
    ].filter((operation): operation is Promise<void> => Boolean(operation)));
}

async function reconcile(
    services: NodeRuntimeServices,
    apply: boolean,
    concurrency: number
): Promise<PlacementEntry[]> {
    if (!services.storage.reconcilePlacement) {
        throw new Error('The active object storage does not support placement reconciliation');
    }
    const keys = [...new Set(
        (await services.storage.list('')).map((object) => object.key)
    )].sort();
    const entries = new Array<PlacementEntry>(keys.length);
    let next = 0;
    await Promise.all(Array.from(
        { length: Math.min(concurrency, keys.length) },
        async () => {
            while (next < keys.length) {
                const index = next;
                next += 1;
                const key = keys[index];
                const current = await services.storage.createReadUrl?.(key);
                if (!current) {
                    entries[index] = { key, result: 'missing' };
                } else if (current.visibility === 'public') {
                    entries[index] = { key, result: 'already-public' };
                } else if (!apply) {
                    entries[index] = { key, result: 'would-move' };
                } else {
                    const moved = await services.storage.reconcilePlacement(key);
                    const verified = await services.storage.createReadUrl?.(key);
                    if (!moved || verified?.visibility !== 'public') {
                        throw new Error(`Failed to verify public placement: ${key}`);
                    }
                    entries[index] = { key, result: 'moved' };
                }
            }
        }
    ));
    return entries;
}

async function main(): Promise<void> {
    const options = parsePublicObjectPlacementArguments(process.argv.slice(2));
    const services = await createNodeServices();
    try {
        const entries = await reconcile(
            services,
            options.apply,
            options.concurrency
        );
        const counts = Object.fromEntries([
            'already-public',
            'missing',
            'moved',
            'would-move'
        ].map((result) => [
            result,
            entries.filter((entry) => entry.result === result).length
        ]));
        const report = {
            generatedAt: new Date().toISOString(),
            applied: options.apply,
            accessClass: 'ready',
            counts,
            entries
        };
        await fs.mkdir(path.dirname(options.report), { recursive: true });
        await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(`Public object placement: ${entries.length} ready object(s)`);
        console.log(`Report: ${options.report}`);
        if (entries.some((entry) => entry.result === 'missing')) process.exitCode = 1;
    } finally {
        await closeServices(services);
    }
}

if (require.main === module) {
    void main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
