import fs from 'node:fs/promises';
import path from 'node:path';
import { createNodeServices } from '@/runtime/node-services';
import { agencyIconObjectKey, idolMediaObjectKey, storyObjectKey } from '@/domains/wiki/service';
import type { NodeRuntimeServices } from '@/ports/runtime-services';

interface Options {
    apply: boolean;
    report: string;
    strict: boolean;
}

interface AppliedMediaAssociation {
    entity: 'agency' | 'idol';
    id: number;
    previousKey: string | null;
    objectKey: string;
}

const projectRoot = path.resolve(__dirname, '../../../..');

export function parseWikiMetadataAuditArguments(argv: string[]): Options {
    const options: Options = {
        apply: false,
        report: path.join(projectRoot, 'data/migration/wiki-metadata-audit.json'),
        strict: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--apply') options.apply = true;
        else if (argument === '--strict') options.strict = true;
        else if (argument === '--report') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error('--report requires a file');
            options.report = path.resolve(projectRoot, value);
        } else if (argument === '--help' || argument === '-h') {
            console.log([
                'Usage: pnpm --filter @imsweb/api run wiki:metadata:audit -- [options]',
                '',
                'Audits database-owned Wiki metadata and associated ObjectStorage keys.',
                'The command only writes the ignored JSON report unless --apply is provided.',
                '',
                'Options:',
                '  --apply           Associate existing semantic agency/idol media, then re-audit',
                '  --strict          Exit non-zero when the final report contains issues',
                '  --report <file>   Report path under data/migration by default',
                '  --help            Show this help'
            ].join('\n'));
            process.exit(0);
        } else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

async function mapLimit<Input, Output>(
    values: readonly Input[],
    limit: number,
    operation: (value: Input) => Promise<Output>
): Promise<Output[]> {
    const results = new Array<Output>(values.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= values.length) return;
            results[index] = await operation(values[index]!);
        }
    }));
    return results;
}

function duplicateValues(values: number[]): number[] {
    const seen = new Set<number>();
    const duplicates = new Set<number>();
    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates];
}

function validColor(value: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(value);
}

function validObjectKey(value: string): boolean {
    const segments = value.split('/');
    return Boolean(value) && !value.startsWith('/') &&
        segments.every((segment) => segment && segment !== '.' && segment !== '..' &&
            !/[\\\0-\x1f\x7f]/.test(segment));
}

async function semanticIdolMediaKey(
    services: Pick<NodeRuntimeServices, 'storage'>,
    agencyCode: string,
    folderName: string
): Promise<string | null> {
    for (const extension of ['.webp', '.png', '.jpg', '.jpeg', '.gif']) {
        const key = idolMediaObjectKey(agencyCode, folderName, extension);
        if (await services.storage.exists(key)) return key;
    }
    return null;
}

export async function applyExistingSemanticMedia(
    services: Pick<NodeRuntimeServices, 'story' | 'storage'>
): Promise<AppliedMediaAssociation[]> {
    const [agencies, idols] = await Promise.all([
        services.story.listAgencies(),
        services.story.listIdolsWithAgencies()
    ]);
    const applied: AppliedMediaAssociation[] = [];
    for (const agency of agencies) {
        if (agency.icon_object_key) continue;
        const key = agencyIconObjectKey(agency.code);
        if (await services.storage.exists(key)) {
            await services.story.setAgencyIconObjectKey(agency.id, key);
            applied.push({
                entity: 'agency',
                id: agency.id,
                previousKey: agency.icon_object_key,
                objectKey: key
            });
        }
    }
    for (const idol of idols) {
        const key = await semanticIdolMediaKey(
            services,
            idol.agency_code,
            idol.folder_name
        );
        if (key && idol.avatar_object_key !== key) {
            await services.story.setIdolAvatarObjectKey(idol.id, key);
            applied.push({
                entity: 'idol',
                id: idol.id,
                previousKey: idol.avatar_object_key,
                objectKey: key
            });
        }
    }
    return applied;
}

async function buildReport(
    services: NodeRuntimeServices,
    applied: AppliedMediaAssociation[]
) {
    const [agencies, idols, groups, members] = await Promise.all([
        services.story.listAgencies(),
        services.story.listIdolsWithAgencies(),
        services.story.listWikiGroups(),
        services.story.listWikiGroupMembers()
    ]);
    const enabledIdols = idols.filter((idol) => idol.wiki_enabled);
    const membersByIdol = new Map<number, number>();
    for (const member of members) {
        membersByIdol.set(member.idol_id, (membersByIdol.get(member.idol_id) ?? 0) + 1);
    }
    const unassignedIdols = enabledIdols
        .filter((idol) => (membersByIdol.get(idol.id) ?? 0) === 0)
        .map((idol) => idol.id);
    const duplicateMembers = [...membersByIdol]
        .filter(([, count]) => count !== 1)
        .map(([idolId]) => idolId);
    const fallbackCounts = agencies.map((agency) => ({
        agencyId: agency.id,
        count: groups.filter((group) => group.agency_id === agency.id && group.is_fallback).length
    })).filter((item) => item.count !== 1);
    const duplicateOrders = {
        agencies: duplicateValues(agencies.filter((agency) => agency.wiki_enabled)
            .map((agency) => agency.display_order)),
        groups: agencies.flatMap((agency) => duplicateValues(groups
            .filter((group) => group.agency_id === agency.id)
            .map((group) => group.display_order))
            .map((order) => ({ agencyId: agency.id, order }))),
        members: groups.flatMap((group) => duplicateValues(members
            .filter((member) => member.group_id === group.id)
            .map((member) => member.display_order))
            .map((order) => ({ groupId: group.id, order })))
    };
    const invalidColors = [
        ...agencies.filter((agency) => !validColor(agency.color)).map((agency) => `agency:${agency.id}`),
        ...groups.filter((group) => !validColor(group.color)).map((group) => `group:${group.id}`),
        ...idols.filter((idol) => idol.color && !validColor(idol.color)).map((idol) => `idol:${idol.id}`)
    ];

    const semanticIdolMedia = await mapLimit(idols, 8, async (idol) => ({
        idolId: idol.id,
        currentKey: idol.avatar_object_key,
        semanticKey: await semanticIdolMediaKey(
            services,
            idol.agency_code,
            idol.folder_name
        )
    }));
    const unassociatedIdolMedia = semanticIdolMedia
        .filter((item) => item.semanticKey && item.currentKey !== item.semanticKey)
        .map((item) => ({
            idolId: item.idolId,
            currentKey: item.currentKey,
            semanticKey: item.semanticKey!
        }));

    const categoryAudits = await mapLimit(enabledIdols, 8, async (idol) => {
        const [categories, stories] = await Promise.all([
            services.story.listWikiCategories(idol.agency_id, idol.id),
            services.story.listStories(idol.agency_code, idol.id)
        ]);
        const known = new Set(categories.map((category) => category.name));
        return {
            idolId: idol.id,
            unknown: [...new Set(stories.map((story) => story.category)
                .filter((category) => !known.has(category)))],
            storyKeys: stories.flatMap((story) => story.image_file
                ? [storyObjectKey(idol.agency_code, idol.folder_name, story.image_file)]
                : [])
        };
    });
    const unknownCategories = categoryAudits
        .filter((audit) => audit.unknown.length)
        .map(({ idolId, unknown }) => ({ idolId, categories: unknown }));
    const mediaKeys = [
        ...agencies.flatMap((agency) => [
            agency.icon_object_key,
            agency.fallback_artwork_object_key
        ]),
        ...groups.map((group) => group.icon_object_key),
        ...idols.map((idol) => idol.avatar_object_key),
        ...categoryAudits.flatMap((audit) => audit.storyKeys)
    ].filter((key): key is string => Boolean(key));
    const invalidObjectKeys = [...new Set(mediaKeys.filter((key) => !validObjectKey(key)))];
    const missingObjects = (await mapLimit(
        [...new Set(mediaKeys.filter(validObjectKey))],
        8,
        async (key) => ({ key, exists: await services.storage.exists(key) })
    )).filter((item) => !item.exists).map((item) => item.key);

    const issues = {
        unassignedIdols,
        duplicateMembers,
        fallbackCounts,
        duplicateOrders,
        unknownCategories,
        invalidColors,
        invalidObjectKeys,
        unassociatedIdolMedia,
        missingObjects
    };
    const issueCount = unassignedIdols.length + duplicateMembers.length + fallbackCounts.length +
        duplicateOrders.agencies.length + duplicateOrders.groups.length +
        duplicateOrders.members.length + unknownCategories.length + invalidColors.length +
        invalidObjectKeys.length + unassociatedIdolMedia.length + missingObjects.length;
    return {
        generatedAt: new Date().toISOString(),
        applied,
        counts: {
            agencies: agencies.length,
            enabledIdols: enabledIdols.length,
            groups: groups.length,
            members: members.length,
            associatedMedia: mediaKeys.length
        },
        issueCount,
        issues
    };
}

async function closeServices(services: NodeRuntimeServices) {
    await Promise.allSettled([
        services.storage.close?.(),
        services.story.close?.(),
        (services.backofficeAuth as { close?: () => Promise<void> }).close?.()
    ].filter((operation): operation is Promise<void> => Boolean(operation)));
}

async function main() {
    const options = parseWikiMetadataAuditArguments(process.argv.slice(2));
    const services = await createNodeServices();
    try {
        const applied = options.apply ? await applyExistingSemanticMedia(services) : [];
        const report = await buildReport(services, applied);
        await fs.mkdir(path.dirname(options.report), { recursive: true });
        await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(`Wiki metadata audit: ${report.issueCount} issue(s)`);
        console.log(`Report: ${options.report}`);
        if (options.strict && report.issueCount) process.exitCode = 1;
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
