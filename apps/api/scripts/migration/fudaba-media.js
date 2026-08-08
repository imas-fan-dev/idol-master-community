'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const {
    FUDABA_D1_DATABASE_ID,
    FUDABA_R2_BUCKET,
    INCLUDED_CLASSIFICATIONS,
    canonicalHash,
    descriptorIndex,
    loadSnapshot,
    parseTimestamp,
    sha256File,
    sourceRowIdentity,
    validateSnapshotId
} = require('./fudaba-metadata');

const ALLOWED_IMAGE_TYPES = new Set([
    'image/avif', 'image/jpeg', 'image/png', 'image/webp'
]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REVIEW_STATUSES = new Set(['approved', 'denied', 'unknown']);

class FudabaMediaBlockedError extends Error {
    constructor(message, report) {
        super(message);
        this.name = 'FudabaMediaBlockedError';
        this.report = report;
    }
}

function sha256(body) {
    return crypto.createHash('sha256').update(body).digest('hex');
}

function detectedImageContentType(body) {
    if (body.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )) return 'image/png';
    if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
    if (body.subarray(0, 4).toString('ascii') === 'RIFF' &&
        body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (body.length >= 12 && body.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = body.subarray(8, 12).toString('ascii');
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    return null;
}

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertRegularFile(filename, label) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return stat;
}

function readJsonArtifact(filename, label) {
    assertRegularFile(filename, label);
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
    return { filename, sha256: sha256File(filename), value };
}

function writeJsonAtomic(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    try {
        fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filename);
        fs.chmodSync(filename, 0o600);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function writeJsonIfChanged(filename, value) {
    if (fs.existsSync(filename)) {
        const existing = readJsonArtifact(filename, path.basename(filename)).value;
        if (canonicalHash(existing) === canonicalHash(value)) {
            fs.chmodSync(filename, 0o600);
            return false;
        }
    }
    writeJsonAtomic(filename, value);
    return true;
}

function safeRelativePath(value, label) {
    if (typeof value !== 'string' || !value || value !== value.normalize('NFC') ||
        path.posix.isAbsolute(value) || value.includes('\\') ||
        value.split('/').some((segment) =>
            !segment || segment === '.' || segment === '..' ||
            /[\x00-\x1f\x7f]/.test(segment)
        )) {
        throw new Error(`${label} is not a safe normalized relative path`);
    }
    return value;
}

function sourceFile(sourceRoot, exportPath) {
    const root = path.resolve(sourceRoot);
    const filename = path.resolve(root, ...safeRelativePath(exportPath, 'inventory exportPath').split('/'));
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Inventory export path escapes source root: ${exportPath}`);
    }
    return filename;
}

function filesUnder(root) {
    const files = [];
    function visit(directory, segments) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            const relative = [...segments, entry.name].join('/').normalize('NFC');
            const stat = fs.lstatSync(filename);
            if (stat.isSymbolicLink()) {
                throw new Error(`Fudaba media export contains a symlink: ${relative}`);
            }
            if (stat.isDirectory()) visit(filename, [...segments, entry.name]);
            else if (stat.isFile()) files.push(relative);
            else throw new Error(`Fudaba media export contains a non-regular entry: ${relative}`);
        }
    }
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Fudaba media source root must be a non-symlink directory');
    }
    visit(root, []);
    return files.sort(compareUtf8);
}

function normalizeContentType(value) {
    const contentType = String(value || '').split(';', 1)[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
        throw new Error(`Unsupported Fudaba image content type: ${String(value)}`);
    }
    return contentType;
}

function normalizeEtag(value) {
    const etag = String(value || '').trim().replace(/^"|"$/g, '');
    if (!etag || /[\x00-\x1f\x7f]/.test(etag)) throw new Error('Inventory ETag is invalid');
    return etag;
}

function normalizedMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Inventory customMetadata must be an object');
    }
    const output = {};
    for (const [key, raw] of Object.entries(value)) {
        const normalized = key.toLowerCase();
        if (!normalized || Object.hasOwn(output, normalized) || typeof raw !== 'string') {
            throw new Error('Inventory customMetadata is invalid or ambiguous');
        }
        output[normalized] = raw;
    }
    return output;
}

function verifiedFile(filename, entry) {
    const before = fs.lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error(`Inventory source is not a regular file: ${entry.exportPath}`);
    }
    const body = fs.readFileSync(filename);
    const after = fs.lstatSync(filename, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || BigInt(body.byteLength) !== after.size) {
        throw new Error(`Inventory source changed while reading: ${entry.exportPath}`);
    }
    if (body.byteLength !== entry.bytes || sha256(body) !== entry.sha256) {
        throw new Error(`Inventory source bytes or SHA-256 differ: ${entry.exportPath}`);
    }
    const sniffed = detectedImageContentType(body);
    if (sniffed !== entry.contentType) {
        throw new Error(`Inventory source MIME differs: ${entry.exportPath}`);
    }
    return body;
}

function validateInventoryIdentity(document, snapshot) {
    if (document.schemaVersion !== 1 || document.complete !== true ||
        document.snapshotId !== snapshot.sourceJson.snapshotId ||
        document.sourceSha256 !== snapshot.sourceJson.sourceExport.sha256 ||
        document.sourceCommit !== snapshot.sourceJson.source.commit ||
        document.d1DatabaseId !== FUDABA_D1_DATABASE_ID ||
        document.sourceBucket !== FUDABA_R2_BUCKET ||
        document.sourceBucket !== snapshot.sourceJson.source.r2Bucket ||
        !Array.isArray(document.entries) || document.objectCount !== document.entries.length) {
        throw new Error('Fudaba R2 inventory identity is incomplete or mismatched');
    }
    parseTimestamp(document.generatedAt, 'R2 inventory generatedAt');
}

function loadVerifiedInventory(filename, sourceRoot, snapshot) {
    const artifact = readJsonArtifact(filename, 'Fudaba R2 inventory');
    const document = artifact.value;
    validateInventoryIdentity(document, snapshot);
    const root = path.resolve(sourceRoot);
    const entries = [];
    const byKey = new Map();
    const exportPaths = new Set();
    let previousKey = null;
    for (const raw of document.entries) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Fudaba R2 inventory entries must be objects');
        }
        const key = safeRelativePath(raw.key, 'inventory key');
        if (previousKey !== null && compareUtf8(previousKey, key) >= 0) {
            throw new Error('Fudaba R2 inventory entries must use unique UTF-8 byte order');
        }
        previousKey = key;
        if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 1) {
            throw new Error(`Inventory byte count is invalid: ${key}`);
        }
        if (!SHA256_PATTERN.test(raw.sha256 || '')) {
            throw new Error(`Inventory SHA-256 is invalid: ${key}`);
        }
        const exportPath = safeRelativePath(raw.exportPath, 'inventory exportPath');
        if (byKey.has(key) || exportPaths.has(exportPath)) {
            throw new Error(`Duplicate inventory key or export path: ${key}`);
        }
        const entry = {
            key,
            versionId: raw.versionId === null ? null : String(raw.versionId || ''),
            etag: normalizeEtag(raw.etag),
            bytes: raw.bytes,
            contentType: normalizeContentType(raw.contentType),
            sha256: raw.sha256,
            customMetadata: normalizedMetadata(raw.customMetadata),
            exportPath
        };
        if (entry.versionId !== null && !entry.versionId) {
            throw new Error(`Inventory versionId is invalid: ${key}`);
        }
        const body = verifiedFile(sourceFile(root, exportPath), entry);
        entries.push({ ...entry, body });
        byKey.set(key, entries.at(-1));
        exportPaths.add(exportPath);
    }
    const actualFiles = filesUnder(root);
    const expectedFiles = [...exportPaths].sort(compareUtf8);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error('Fudaba media export files do not exactly match the frozen inventory');
    }
    return { artifact, byKey, document, entries };
}

function includedDescriptor(descriptors, table, row) {
    const descriptor = descriptors.get(sourceRowIdentity(table, row));
    return descriptor && INCLUDED_CLASSIFICATIONS.has(descriptor.classification)
        ? descriptor
        : null;
}

function collectMediaReferences(snapshot) {
    const descriptors = descriptorIndex(snapshot.rowsManifest);
    const loginAccounts = new Set();
    for (const table of ['oauth_accounts', 'email_credentials']) {
        for (const row of snapshot.rows[table]) {
            if (includedDescriptor(descriptors, table, row)) loginAccounts.add(row.user_id);
        }
    }
    const includedUsers = new Set();
    for (const row of snapshot.rows.users) {
        const descriptor = includedDescriptor(descriptors, 'users', row);
        if (!descriptor) continue;
        if (descriptor.classification === 'owner-approved-reference') {
            if (typeof descriptor.targetAccountId === 'string' && descriptor.targetAccountId) {
                includedUsers.add(row.id);
            }
        } else if (loginAccounts.has(row.id)) {
            includedUsers.add(row.id);
        }
    }
    const includedSeries = new Set(snapshot.rows.series_tags
        .filter((row) => includedDescriptor(descriptors, 'series_tags', row))
        .map((row) => row.name));
    const references = [];
    for (const row of snapshot.rows.users) {
        const descriptor = includedDescriptor(descriptors, 'users', row);
        if (!descriptor || descriptor.classification === 'owner-approved-reference' ||
            !includedUsers.has(row.id) || row.avatar_url === '') continue;
        references.push({
            entityKind: 'account', entityId: row.id, ownerId: row.id,
            slot: 'avatar', sourceReference: row.avatar_url, required: false,
            allowExternal: true
        });
    }
    for (const row of snapshot.rows.offices) {
        if (!includedDescriptor(descriptors, 'offices', row) ||
            !includedUsers.has(row.owner_id) || row.cover_image === '') continue;
        references.push({
            entityKind: 'office', entityId: row.id, ownerId: row.owner_id,
            slot: 'cover', sourceReference: row.cover_image, required: false,
            allowExternal: false
        });
    }
    for (const row of snapshot.rows.cards) {
        if (!includedDescriptor(descriptors, 'cards', row) ||
            !includedUsers.has(row.owner_id) || !includedSeries.has(row.series)) continue;
        for (const [slot, sourceReference] of [
            ['front', row.front_image], ['back', row.back_image]
        ]) {
            references.push({
                entityKind: 'card', entityId: row.id, ownerId: row.owner_id,
                slot, sourceReference, required: true, allowExternal: false
            });
        }
    }
    return references.sort((left, right) => compareUtf8(
        JSON.stringify([left.entityKind, left.entityId, left.slot]),
        JSON.stringify([right.entityKind, right.entityId, right.slot])
    ));
}

function mediaIdentity(entry) {
    return JSON.stringify([entry.entityKind, entry.entityId, entry.slot]);
}

function r2KeyFromLocator(locator) {
    if (typeof locator !== 'string' || !locator.startsWith('/media/') ||
        locator.includes('?') || locator.includes('#') || locator.includes('\\') ||
        /[\x00-\x1f\x7f]/.test(locator)) {
        throw new Error(`Invalid Fudaba R2 media locator: ${String(locator)}`);
    }
    const raw = locator.slice('/media/'.length);
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        throw new Error(`Invalid Fudaba R2 media encoding: ${locator}`);
    }
    if (decoded !== raw || decoded.includes('%')) {
        throw new Error(`Fudaba R2 media locator is not canonical: ${locator}`);
    }
    return safeRelativePath(decoded, 'Fudaba R2 key');
}

function assertUploadedKey(reference, key) {
    const segments = key.split('/');
    let filename;
    if (reference.entityKind === 'account') {
        if (segments.length !== 3 || segments[0] !== 'avatars' ||
            segments[1] !== reference.ownerId) {
            throw new Error(`Avatar R2 key does not match its owner: ${key}`);
        }
        filename = segments[2];
        if (!UUID_V4_PATTERN.test(filename.split('-avatar.')[0]) ||
            !/-avatar\.(?:avif|jpg|png|webp)$/.test(filename)) {
            throw new Error(`Avatar R2 key is not upload-generated: ${key}`);
        }
    } else if (reference.entityKind === 'office') {
        if (segments.length !== 3 || segments[0] !== 'offices' ||
            segments[1] !== reference.entityId) {
            throw new Error(`Office R2 key does not match its entity: ${key}`);
        }
        filename = segments[2];
        if (!UUID_V4_PATTERN.test(filename.split('-cover.')[0]) ||
            !/-cover\.(?:avif|jpg|png|webp)$/.test(filename)) {
            throw new Error(`Office R2 key is not upload-generated: ${key}`);
        }
    } else {
        if (segments.length !== 3 || segments[0] !== 'cards' ||
            segments[1] !== reference.ownerId) {
            throw new Error(`Card R2 key does not match its owner: ${key}`);
        }
        filename = segments[2];
        const marker = `-${reference.slot}.`;
        if (!UUID_V4_PATTERN.test(filename.split(marker)[0]) ||
            !new RegExp(`-${reference.slot}\\.(?:avif|jpg|png|webp)$`).test(filename)) {
            throw new Error(`Card R2 key is not upload-generated: ${key}`);
        }
    }
}

function assertSourceMetadata(reference, entry) {
    const metadata = entry.customMetadata;
    if (metadata.ownerid !== reference.ownerId) {
        throw new Error(`R2 owner metadata differs for ${entry.key}`);
    }
    if (reference.entityKind === 'office') {
        if (metadata.officeid !== reference.entityId || metadata.purpose !== 'cover') {
            throw new Error(`R2 office metadata differs for ${entry.key}`);
        }
    } else if (metadata.side !== reference.slot) {
        throw new Error(`R2 side metadata differs for ${entry.key}`);
    }
}

function canonicalExtension(info) {
    if (info.contentType === 'image/jpeg') return 'jpg';
    if (info.contentType === 'image/png') return 'png';
    if (info.contentType === 'image/webp') return 'webp';
    if (info.contentType === 'image/avif') return 'avif';
    throw new Error(`Unsupported decoded Fudaba image format: ${info.format}`);
}

function objectKeyFor(reference, extension, builders) {
    if (reference.entityKind === 'account') {
        return builders.fudabaAccountAvatarObjectKey(reference.entityId, extension);
    }
    if (reference.entityKind === 'office') {
        return builders.fudabaOfficeCoverObjectKey(reference.entityId, extension);
    }
    return reference.slot === 'front'
        ? builders.fudabaCardFrontObjectKey(reference.entityId, extension)
        : builders.fudabaCardBackObjectKey(reference.entityId, extension);
}

async function buildMediaPlan(snapshot, inventory, imageProcessor, builders) {
    const entries = [];
    const referencedSourceKeys = new Set();
    for (const reference of collectMediaReferences(snapshot)) {
        let planEntry = {
            entityKind: reference.entityKind,
            entityId: reference.entityId,
            slot: reference.slot,
            required: reference.required,
            sourceReference: reference.sourceReference,
            sourceType: 'unsupported',
            requestedAction: 'omit',
            logicalObjectKey: null,
            sourceObject: null,
            image: null,
            blocker: reference.required ? 'required-media-is-not-a-frozen-r2-object' : null
        };
        if (/^https:\/\//.test(reference.sourceReference) && reference.allowExternal) {
            let external;
            try {
                external = new URL(reference.sourceReference);
            } catch {
                throw new Error(`Invalid external avatar URL: ${reference.sourceReference}`);
            }
            if (external.username || external.password || external.hash ||
                external.protocol !== 'https:') {
                throw new Error(`Unsafe external avatar URL: ${reference.sourceReference}`);
            }
            planEntry = {
                ...planEntry,
                sourceType: 'external',
                requestedAction: 'retain-external',
                blocker: null
            };
        } else if (reference.sourceReference.startsWith('/media/')) {
            const key = r2KeyFromLocator(reference.sourceReference);
            assertUploadedKey(reference, key);
            const source = inventory.byKey.get(key);
            if (!source) throw new Error(`R2 inventory is missing referenced object: ${key}`);
            if (source.bytes > MAX_IMAGE_BYTES) {
                throw new Error(`Referenced Fudaba image exceeds 8 MiB: ${key}`);
            }
            assertSourceMetadata(reference, source);
            const image = await imageProcessor.validate(source.body, source.contentType);
            const extension = canonicalExtension(image);
            const expectedSourceExtension = path.posix.extname(key).slice(1).toLowerCase();
            if (expectedSourceExtension !== extension) {
                throw new Error(`R2 key extension differs from decoded image: ${key}`);
            }
            const logicalObjectKey = objectKeyFor(reference, extension, builders);
            referencedSourceKeys.add(key);
            const sourceObject = {
                key,
                versionId: source.versionId,
                etag: source.etag,
                bytes: source.bytes,
                contentType: source.contentType,
                sha256: source.sha256,
                metadataSha256: canonicalHash(source.customMetadata)
            };
            planEntry = {
                ...planEntry,
                sourceType: 'r2',
                requestedAction: 'store-protected',
                logicalObjectKey,
                sourceObject,
                image: {
                    format: image.format,
                    width: image.width,
                    height: image.height,
                    contentType: image.contentType
                },
                blocker: null
            };
        }
        planEntry.bindingSha256 = canonicalHash(planEntry);
        entries.push(planEntry);
    }
    const identities = new Set();
    const objectKeys = new Set();
    for (const entry of entries) {
        const identity = mediaIdentity(entry);
        if (identities.has(identity)) throw new Error(`Duplicate media plan identity: ${identity}`);
        identities.add(identity);
        if (entry.logicalObjectKey) {
            if (objectKeys.has(entry.logicalObjectKey)) {
                throw new Error(`Duplicate Fudaba target object key: ${entry.logicalObjectKey}`);
            }
            objectKeys.add(entry.logicalObjectKey);
        }
    }
    return {
        schemaVersion: 2,
        snapshotId: snapshot.sourceJson.snapshotId,
        sourceSha256: snapshot.sourceJson.sourceExport.sha256,
        sourceCommit: snapshot.sourceJson.source.commit,
        sourceBucket: snapshot.sourceJson.source.r2Bucket,
        sourceInventorySha256: inventory.artifact.sha256,
        sourceInventoryObjects: inventory.entries.length,
        referencedSourceObjects: referencedSourceKeys.size,
        entries
    };
}

function approvalScaffold(entry) {
    return {
        entityKind: entry.entityKind,
        entityId: entry.entityId,
        slot: entry.slot,
        sourceReference: entry.sourceReference,
        logicalObjectKey: entry.logicalObjectKey,
        bindingSha256: entry.bindingSha256,
        sourceSha256: entry.sourceObject?.sha256 || null,
        bytes: entry.sourceObject?.bytes || null,
        contentType: entry.sourceObject?.contentType || null,
        status: 'unknown',
        action: entry.requestedAction,
        reviewedBy: null,
        reviewedAt: null,
        evidenceSha256: null
    };
}

function scaffoldRights(snapshot, plan, mediaPlanSha256) {
    return {
        schemaVersion: 2,
        snapshotId: snapshot.sourceJson.snapshotId,
        sourceSha256: snapshot.sourceJson.sourceExport.sha256,
        version: 1,
        mediaPlanSha256,
        approvals: plan.entries.map(approvalScaffold)
    };
}

function plannedMediaEntry(entry) {
    return {
        entityKind: entry.entityKind,
        entityId: entry.entityId,
        slot: entry.slot,
        sourceReference: entry.sourceReference,
        logicalObjectKey: entry.logicalObjectKey,
        bindingSha256: entry.bindingSha256,
        state: 'planned',
        disposition: null,
        bytes: entry.sourceObject?.bytes || null,
        contentType: entry.sourceObject?.contentType || null,
        sha256: entry.sourceObject?.sha256 || null,
        readbackSha256: null,
        targetBucket: null,
        storageScope: null,
        objectId: null,
        physicalObjectKey: null,
        targetEtag: null,
        externalUrl: null
    };
}

function scaffoldMedia(snapshot, plan, mediaPlanSha256) {
    return {
        schemaVersion: 2,
        snapshotId: snapshot.sourceJson.snapshotId,
        sourceSha256: snapshot.sourceJson.sourceExport.sha256,
        version: 1,
        mediaPlanSha256,
        sourceInventorySha256: plan.sourceInventorySha256,
        entries: plan.entries.map(plannedMediaEntry)
    };
}

function validateManifestIdentity(manifest, snapshot, mediaPlanSha256, property, label) {
    if (manifest.schemaVersion !== 2 || manifest.version !== 1 ||
        manifest.snapshotId !== snapshot.sourceJson.snapshotId ||
        manifest.sourceSha256 !== snapshot.sourceJson.sourceExport.sha256 ||
        manifest.mediaPlanSha256 !== mediaPlanSha256 || !Array.isArray(manifest[property])) {
        throw new Error(`${label} identity does not match the media plan`);
    }
}

function exactEntryIndex(entries, label) {
    const index = new Map();
    for (const entry of entries) {
        const identity = mediaIdentity(entry);
        if (!entry || typeof entry !== 'object' || index.has(identity)) {
            throw new Error(`${label} has an invalid or duplicate entry: ${identity}`);
        }
        index.set(identity, entry);
    }
    return index;
}

function validateRights(rights, snapshot, plan, mediaPlanSha256) {
    validateManifestIdentity(
        rights, snapshot, mediaPlanSha256, 'approvals', 'rights manifest'
    );
    const approvals = exactEntryIndex(rights.approvals, 'rights manifest');
    const blockers = [];
    for (const planned of plan.entries) {
        const identity = mediaIdentity(planned);
        const approval = approvals.get(identity);
        if (!approval || approval.bindingSha256 !== planned.bindingSha256 ||
            approval.sourceReference !== planned.sourceReference ||
            approval.logicalObjectKey !== planned.logicalObjectKey ||
            approval.sourceSha256 !== (planned.sourceObject?.sha256 || null) ||
            approval.bytes !== (planned.sourceObject?.bytes || null) ||
            approval.contentType !== (planned.sourceObject?.contentType || null) ||
            !REVIEW_STATUSES.has(approval.status)) {
            throw new Error(`Rights approval does not match its media binding: ${identity}`);
        }
        if (approval.status === 'unknown') {
            blockers.push({ identity, code: 'rights-review-required' });
            continue;
        }
        if (typeof approval.reviewedBy !== 'string' || !approval.reviewedBy.trim() ||
            !SHA256_PATTERN.test(approval.evidenceSha256 || '')) {
            throw new Error(`Rights review evidence is incomplete: ${identity}`);
        }
        parseTimestamp(approval.reviewedAt, 'rights reviewedAt');
        if (approval.status === 'approved') {
            const expected = planned.sourceType === 'r2'
                ? 'store-protected'
                : planned.sourceType === 'external'
                    ? 'retain-external'
                    : null;
            if (!expected || approval.action !== expected) {
                blockers.push({ identity, code: 'approved-action-not-supported' });
            }
        } else if (approval.action !== 'omit' || planned.required) {
            blockers.push({ identity, code: planned.required
                ? 'required-media-rights-denied'
                : 'denied-media-must-be-omitted' });
        }
    }
    const plannedIdentities = new Set(plan.entries.map(mediaIdentity));
    for (const identity of approvals.keys()) {
        if (!plannedIdentities.has(identity)) {
            throw new Error(`Rights manifest has an orphan approval: ${identity}`);
        }
    }
    return { approvals, blockers };
}

function validateExistingMedia(media, snapshot, plan, mediaPlanSha256) {
    validateManifestIdentity(media, snapshot, mediaPlanSha256, 'entries', 'media manifest');
    if (media.sourceInventorySha256 !== plan.sourceInventorySha256) {
        throw new Error('Media manifest does not match the source inventory');
    }
    const entries = exactEntryIndex(media.entries, 'media manifest');
    for (const planned of plan.entries) {
        const entry = entries.get(mediaIdentity(planned));
        if (!entry || entry.bindingSha256 !== planned.bindingSha256 ||
            entry.sourceReference !== planned.sourceReference ||
            entry.logicalObjectKey !== planned.logicalObjectKey ||
            !['planned', 'ready', 'external', 'omitted'].includes(entry.state)) {
            throw new Error(`Media manifest entry differs from the plan: ${mediaIdentity(planned)}`);
        }
    }
    if (entries.size !== plan.entries.length) {
        throw new Error('Media manifest contains entries not present in the media plan');
    }
    return entries;
}

function targetMatches(entry, target, stored) {
    return target && stored && target.state === 'ready' && target.storageScope === 'private' &&
        typeof target.objectId === 'string' && target.objectId &&
        typeof target.physicalObjectKey === 'string' && target.physicalObjectKey &&
        typeof target.etag === 'string' && target.etag &&
        Number(target.byteSize) === entry.sourceObject.bytes &&
        target.contentType === entry.sourceObject.contentType &&
        target.sha256 === entry.sourceObject.sha256 &&
        stored.size === entry.sourceObject.bytes &&
        stored.contentType === entry.sourceObject.contentType &&
        sha256(stored.body) === entry.sourceObject.sha256;
}

async function inspectTransferTarget(entry, targetRuntime) {
    const target = await targetRuntime.inspectTarget(entry.logicalObjectKey);
    const stored = target ? await targetRuntime.storage.get(entry.logicalObjectKey) : null;
    if (!target && !stored) return { state: 'missing', target: null };
    if (targetMatches(entry, target, stored)) return { state: 'unchanged', target };
    return {
        state: 'conflict',
        target: target || null,
        reason: !target ? 'unmanaged-object-visible' :
            target.storageScope !== 'private' ? 'target-is-public' :
                target.state !== 'ready' ? 'target-state-mismatch' : 'target-content-mismatch'
    };
}

function finalNonTransferEntry(planned, approval) {
    const base = plannedMediaEntry(planned);
    if (approval.status === 'approved' && approval.action === 'retain-external') {
        return {
            ...base,
            state: 'external',
            disposition: 'retain-external',
            externalUrl: planned.sourceReference
        };
    }
    return { ...base, state: 'omitted', disposition: 'omit' };
}

function finalTransferredEntry(planned, target, targetBucket) {
    return {
        ...plannedMediaEntry(planned),
        state: 'ready',
        disposition: 'store-protected',
        readbackSha256: planned.sourceObject.sha256,
        targetBucket,
        storageScope: 'private',
        objectId: target.objectId,
        physicalObjectKey: target.physicalObjectKey,
        targetEtag: target.etag,
        externalUrl: null
    };
}

function confirmationPairs(options, artifacts, sourceBucket, targetBucket) {
    return [
        ['--confirm-snapshot-id', options.confirmSnapshotId, artifacts.snapshotId],
        ['--confirm-source-sha256', options.confirmSourceSha256, artifacts.sourceSha256],
        ['--confirm-source-manifest-sha256', options.confirmSourceManifestSha256,
            artifacts.sourceManifestSha256],
        ['--confirm-rows-sha256', options.confirmRowsSha256, artifacts.rowsSha256],
        ['--confirm-inventory-sha256', options.confirmInventorySha256,
            artifacts.inventorySha256],
        ['--confirm-plan-sha256', options.confirmPlanSha256, artifacts.planSha256],
        ['--confirm-rights-sha256', options.confirmRightsSha256, artifacts.rightsSha256],
        ['--confirm-media-sha256', options.confirmMediaSha256, artifacts.mediaSha256],
        ['--confirm-source-bucket', options.confirmSourceBucket, sourceBucket],
        ['--confirm-target-bucket', options.confirmTargetBucket, targetBucket]
    ];
}

function assertApplyConfirmations(options, artifacts, sourceBucket, targetBucket) {
    for (const [name, actual, expected] of confirmationPairs(
        options, artifacts, sourceBucket, targetBucket
    )) {
        if (actual !== expected) {
            throw new FudabaMediaBlockedError(`Apply requires exact ${name}`, {
                status: 'blocked',
                snapshotId: artifacts.snapshotId,
                sourceSha256: artifacts.sourceSha256,
                sourceBucket,
                targetBucket,
                artifactSha256: artifacts
            });
        }
    }
}

async function applyMissingTransfers(
    missing,
    runtime,
    ownerToken,
    targetBucket,
    snapshotId = ownerToken
) {
    if (typeof runtime.storage.putIfUnchanged !== 'function' ||
        typeof runtime.storage.deleteIfOwned !== 'function' ||
        typeof runtime.storage.deleteIfObjectId !== 'function') {
        throw new Error(
            'Fudaba media apply requires CAS and fenced object-storage mutations'
        );
    }
    const created = [];
    const results = new Map();
    let attempted = null;
    try {
        for (const entry of missing) {
            attempted = entry;
            const options = {
                contentType: entry.sourceObject.contentType,
                sha256: entry.sourceObject.sha256,
                protectedAccess: true,
                ownerToken,
                metadata: {
                    migration: 'fudaba-media',
                    snapshotId,
                    sourceKey: entry.sourceObject.key,
                    sourceEtag: entry.sourceObject.etag
                }
            };
            const stored = await runtime.storage.putIfUnchanged(
                entry.logicalObjectKey, null, entry.sourceBody, options
            );
            if (!stored) throw new Error(`Concurrent target mutation: ${entry.logicalObjectKey}`);
            const target = await runtime.inspectTarget(entry.logicalObjectKey);
            const readback = await runtime.storage.get(entry.logicalObjectKey);
            if (!targetMatches(entry, target, readback) || target.ownerToken !== ownerToken) {
                throw new Error(`Protected target readback failed: ${entry.logicalObjectKey}`);
            }
            created.push({ key: entry.logicalObjectKey, objectId: target.objectId });
            results.set(mediaIdentity(entry), finalTransferredEntry(entry, target, targetBucket));
            attempted = null;
        }
        return { created, results };
    } catch (error) {
        const compensation = [];
        if (attempted) {
            try {
                const deleted = await runtime.storage.deleteIfOwned(
                    attempted.logicalObjectKey, ownerToken
                );
                compensation.push({ key: attempted.logicalObjectKey, deleted, fence: 'ownerToken' });
            } catch (cleanupError) {
                compensation.push({
                    key: attempted.logicalObjectKey,
                    deleted: false,
                    fence: 'ownerToken',
                    error: cleanupError.message
                });
            }
        }
        for (const object of [...created].reverse()) {
            try {
                const deleted = await runtime.storage.deleteIfObjectId(
                    object.key, object.objectId
                );
                compensation.push({ ...object, deleted, fence: 'objectId' });
            } catch (cleanupError) {
                compensation.push({
                    ...object,
                    deleted: false,
                    fence: 'objectId',
                    error: cleanupError.message
                });
            }
        }
        error.compensation = compensation;
        throw error;
    }
}

async function runFudabaMediaMigration(options, dependencies = {}) {
    const snapshotDirectory = path.resolve(options.snapshotDirectory);
    const snapshot = dependencies.snapshot || await loadSnapshot(snapshotDirectory);
    const inventory = loadVerifiedInventory(
        path.resolve(options.inventory), path.resolve(options.sourceRoot), snapshot
    );
    const imageProcessor = dependencies.imageProcessor || new (
        require('../../src/infra/media/sharp/image-processor.ts').SharpImageProcessor
    )();
    const builders = dependencies.builders || require(
        '../../src/utils/storage/business-object-keys.ts'
    );
    const plan = await buildMediaPlan(snapshot, inventory, imageProcessor, builders);
    const planFile = path.join(snapshotDirectory, 'media-plan.json');
    writeJsonIfChanged(planFile, plan);
    const mediaPlanSha256 = sha256File(planFile);
    const rightsFile = path.join(snapshotDirectory, 'rights-manifest.json');
    let rights = readJsonArtifact(rightsFile, 'rights manifest').value;
    if (Array.isArray(rights.approvals) && rights.approvals.length === 0 &&
        rights.mediaPlanSha256 === null) {
        rights = scaffoldRights(snapshot, plan, mediaPlanSha256);
        writeJsonAtomic(rightsFile, rights);
    }
    const mediaFile = path.join(snapshotDirectory, 'media-manifest.json');
    let media = readJsonArtifact(mediaFile, 'media manifest').value;
    if (Array.isArray(media.entries) && media.entries.length === 0 &&
        media.mediaPlanSha256 === null) {
        media = scaffoldMedia(snapshot, plan, mediaPlanSha256);
        writeJsonAtomic(mediaFile, media);
    }
    const rightsValidation = validateRights(
        rights, snapshot, plan, mediaPlanSha256
    );
    validateExistingMedia(media, snapshot, plan, mediaPlanSha256);
    const artifacts = {
        snapshotId: snapshot.sourceJson.snapshotId,
        sourceSha256: snapshot.sourceJson.sourceExport.sha256,
        sourceManifestSha256: snapshot.artifactSha256.source,
        rowsSha256: snapshot.artifactSha256.rows,
        inventorySha256: inventory.artifact.sha256,
        planSha256: mediaPlanSha256,
        rightsSha256: sha256File(rightsFile),
        mediaSha256: sha256File(mediaFile)
    };
    const targetBucket = dependencies.targetBucket || options.targetBucket;
    if (typeof targetBucket !== 'string' || !targetBucket) {
        throw new Error('Target S3 bucket is required');
    }
    if (options.apply) {
        assertApplyConfirmations(
            options, artifacts, snapshot.sourceJson.source.r2Bucket, targetBucket
        );
    }
    const report = {
        schemaVersion: 2,
        snapshotId: artifacts.snapshotId,
        sourceSha256: artifacts.sourceSha256,
        sourceBucket: snapshot.sourceJson.source.r2Bucket,
        targetBucket,
        apply: options.apply === true,
        status: 'blocked',
        artifactSha256: artifacts,
        summary: {
            inventoryObjects: inventory.entries.length,
            mediaEntries: plan.entries.length,
            transferEntries: plan.entries.filter((entry) => entry.sourceType === 'r2').length,
            externalEntries: plan.entries.filter((entry) => entry.sourceType === 'external').length,
            omittedEntries: 0,
            unchanged: 0,
            missing: 0,
            uploaded: 0,
            conflicts: 0,
            blockers: 0
        },
        blockers: [
            ...plan.entries.filter((entry) => entry.blocker).map((entry) => ({
                identity: mediaIdentity(entry), code: entry.blocker
            })),
            ...rightsValidation.blockers
        ],
        targets: [],
        compensation: []
    };
    const reportFile = path.resolve(
        options.report || path.join(snapshotDirectory, 'media-reconciliation.json')
    );
    report.summary.blockers = report.blockers.length;
    if (report.blockers.length) {
        writeJsonAtomic(reportFile, report);
        return report;
    }

    const runtime = dependencies.targetRuntime || await dependencies.resolveTarget?.();
    if (!runtime || !runtime.storage || typeof runtime.inspectTarget !== 'function') {
        throw new Error('Fudaba media target runtime is unavailable');
    }
    try {
        const approvals = rightsValidation.approvals;
        const transferEntries = plan.entries.filter((entry) => {
            const approval = approvals.get(mediaIdentity(entry));
            return approval.status === 'approved' && approval.action === 'store-protected';
        }).map((entry) => ({
            ...entry,
            sourceBody: inventory.byKey.get(entry.sourceObject.key).body
        }));
        const missing = [];
        const existingResults = new Map();
        for (const entry of transferEntries) {
            const inspection = await inspectTransferTarget(entry, runtime);
            report.targets.push({
                identity: mediaIdentity(entry),
                logicalObjectKey: entry.logicalObjectKey,
                state: inspection.state,
                reason: inspection.reason || null,
                objectId: inspection.target?.objectId || null
            });
            if (inspection.state === 'missing') {
                report.summary.missing += 1;
                missing.push(entry);
            } else if (inspection.state === 'unchanged') {
                report.summary.unchanged += 1;
                existingResults.set(
                    mediaIdentity(entry),
                    finalTransferredEntry(entry, inspection.target, targetBucket)
                );
            } else {
                report.summary.conflicts += 1;
                report.blockers.push({
                    identity: mediaIdentity(entry),
                    code: inspection.reason
                });
            }
        }
        report.summary.blockers = report.blockers.length;
        if (report.blockers.length || !options.apply) {
            report.status = report.blockers.length ? 'blocked' : 'ready';
            writeJsonAtomic(reportFile, report);
            return report;
        }
        const ownerToken = `fudaba-media:${snapshot.sourceJson.snapshotId}:` +
            crypto.randomUUID();
        let applied;
        try {
            applied = await applyMissingTransfers(
                missing,
                runtime,
                ownerToken,
                targetBucket,
                snapshot.sourceJson.snapshotId
            );
        } catch (error) {
            report.status = 'failed';
            report.compensation = error.compensation || [];
            report.blockers.push({ code: 'target-write-failed', detail: error.message });
            report.summary.blockers = report.blockers.length;
            writeJsonAtomic(reportFile, report);
            throw new FudabaMediaBlockedError(
                `Fudaba media apply failed: ${error.message}`, report
            );
        }
        report.summary.uploaded = applied.results.size;
        const finalEntries = plan.entries.map((entry) => {
            const identity = mediaIdentity(entry);
            const transferred = applied.results.get(identity) || existingResults.get(identity);
            return transferred || finalNonTransferEntry(entry, approvals.get(identity));
        });
        const finalMedia = {
            ...media,
            sourceInventorySha256: inventory.artifact.sha256,
            entries: finalEntries
        };
        writeJsonAtomic(mediaFile, finalMedia);
        report.artifactSha256.mediaSha256 = sha256File(mediaFile);
        report.summary.omittedEntries = finalEntries.filter(
            (entry) => entry.state === 'omitted'
        ).length;
        report.status = 'passed';
        writeJsonAtomic(reportFile, report);
        return report;
    } finally {
        await runtime.close?.();
    }
}

function createPostgresTargetInspector(connectionString) {
    const pool = new Pool({
        connectionString,
        max: 1,
        allowExitOnIdle: true,
        application_name: 'imsweb-fudaba-media-inspector'
    });
    return {
        async inspectTarget(logicalKey) {
            const result = await pool.query(
                `SELECT i.state, v.object_id, v.physical_key, v.storage_scope,
                        v.byte_size, v.content_type, v.sha256, v.etag, v.owner_token
                 FROM public.s3_object_index AS i
                 JOIN public.s3_object_versions AS v ON v.object_id=i.object_id
                 WHERE i.logical_key=$1`,
                [logicalKey]
            );
            const row = result.rows[0];
            return row ? {
                state: row.state,
                objectId: row.object_id,
                physicalObjectKey: row.physical_key,
                storageScope: row.storage_scope,
                byteSize: Number(row.byte_size),
                contentType: row.content_type,
                sha256: row.sha256,
                etag: row.etag,
                ownerToken: row.owner_token
            } : null;
        },
        close() {
            return pool.end();
        }
    };
}

function optionValue(argv, index, option) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

function parseArguments(argv) {
    const options = { apply: false, help: false };
    const names = {
        '--snapshot': 'snapshotDirectory',
        '--source-root': 'sourceRoot',
        '--inventory': 'inventory',
        '--report': 'report',
        '--confirm-snapshot-id': 'confirmSnapshotId',
        '--confirm-source-sha256': 'confirmSourceSha256',
        '--confirm-source-manifest-sha256': 'confirmSourceManifestSha256',
        '--confirm-rows-sha256': 'confirmRowsSha256',
        '--confirm-inventory-sha256': 'confirmInventorySha256',
        '--confirm-plan-sha256': 'confirmPlanSha256',
        '--confirm-rights-sha256': 'confirmRightsSha256',
        '--confirm-media-sha256': 'confirmMediaSha256',
        '--confirm-source-bucket': 'confirmSourceBucket',
        '--confirm-target-bucket': 'confirmTargetBucket'
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument === '--apply') options.apply = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else if (names[argument]) {
            options[names[argument]] = optionValue(argv, index, argument);
            index += 1;
        } else throw new Error(`Unknown option: ${argument}`);
    }
    if (!options.help) {
        if (!options.snapshotDirectory || !options.sourceRoot) {
            throw new Error(mediaHelp());
        }
        options.snapshotDirectory = path.resolve(options.snapshotDirectory);
        options.sourceRoot = path.resolve(options.sourceRoot);
        options.inventory = path.resolve(
            options.inventory || path.join(options.snapshotDirectory, 'source-r2-inventory.json')
        );
        if (options.report) options.report = path.resolve(options.report);
    }
    return options;
}

function mediaHelp() {
    return [
        'Usage: fudaba-media-sync.js --snapshot DIRECTORY --source-root DIRECTORY [options]',
        '',
        'Validates a frozen Fudaba R2 export and writes v2 media/rights artifacts.',
        'The command is target-read-only unless --apply and every exact confirmation are present.',
        '',
        'Options:',
        '  --inventory FILE',
        '  --report FILE',
        '  --apply',
        '  --confirm-snapshot-id ID',
        '  --confirm-source-sha256 SHA256',
        '  --confirm-source-manifest-sha256 SHA256',
        '  --confirm-rows-sha256 SHA256',
        '  --confirm-inventory-sha256 SHA256',
        '  --confirm-plan-sha256 SHA256',
        '  --confirm-rights-sha256 SHA256',
        '  --confirm-media-sha256 SHA256',
        `  --confirm-source-bucket ${FUDABA_R2_BUCKET}`,
        '  --confirm-target-bucket BUCKET'
    ].join('\n');
}

async function defaultTargetRuntime(environment) {
    const { databaseUrl } = require('./fudaba-metadata');
    const connectionString = databaseUrl(environment.DATABASE_URL);
    const { resolveNodeServices, closeNodeServices } = require(
        '../../src/runtime/node-services.ts'
    );
    const services = await resolveNodeServices();
    const inspector = createPostgresTargetInspector(connectionString);
    return {
        storage: services.storage,
        inspectTarget: inspector.inspectTarget,
        async close() {
            await Promise.allSettled([inspector.close(), closeNodeServices()]);
        }
    };
}

async function mediaMain(argv = process.argv.slice(2), environment = process.env) {
    try {
        const options = parseArguments(argv);
        if (options.help) {
            process.stdout.write(`${mediaHelp()}\n`);
            return null;
        }
        require('../../src/config/load-environment.ts');
        const { parseNodeObjectStorageConfig } = require('../../src/config/object-storage.ts');
        const storage = parseNodeObjectStorageConfig(environment);
        if (storage.type !== 's3') throw new Error('Fudaba media migration requires S3 storage');
        options.targetBucket = storage.bucket;
        const report = await runFudabaMediaMigration(options, {
            targetBucket: storage.bucket,
            resolveTarget: () => defaultTargetRuntime(environment)
        });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (report.status === 'blocked' || report.status === 'failed') process.exitCode = 2;
        return report;
    } catch (error) {
        if (error.report) process.stderr.write(`${JSON.stringify(error.report, null, 2)}\n`);
        console.error(error.message);
        process.exitCode = 1;
        return null;
    }
}

module.exports = {
    FudabaMediaBlockedError,
    MAX_IMAGE_BYTES,
    applyMissingTransfers,
    buildMediaPlan,
    collectMediaReferences,
    createPostgresTargetInspector,
    loadVerifiedInventory,
    mediaHelp,
    mediaMain,
    parseArguments,
    r2KeyFromLocator,
    runFudabaMediaMigration,
    validateRights
};
