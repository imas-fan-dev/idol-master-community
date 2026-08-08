import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcrypt';
import type { PasswordVerifier } from '@/ports/security';

const pbkdf2Async = promisify(pbkdf2);
const BCRYPT_MAX_PASSWORD_BYTES = 72;

function isBcryptSafe(value: string): boolean {
    return Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_PASSWORD_BYTES;
}

export class BcryptPasswordVerifier implements PasswordVerifier {
    verify(value: string, digest: string): Promise<boolean> {
        if (!isBcryptSafe(value)) return Promise.resolve(false);
        return bcrypt.compare(value, digest);
    }

    hash(value: string): Promise<string> {
        if (!isBcryptSafe(value)) {
            return Promise.reject(new RangeError(
                `bcrypt passwords must not exceed ${BCRYPT_MAX_PASSWORD_BYTES} UTF-8 bytes`
            ));
        }
        return bcrypt.hash(value, 12);
    }

    async verifyPbkdf2Sha256(
        value: string,
        salt: string,
        digest: string
    ): Promise<boolean> {
        if (!/^[0-9a-f]{64}$/.test(digest)) return false;
        const derived = await pbkdf2Async(value, salt, 100_000, 32, 'sha256');
        return timingSafeEqual(derived, Buffer.from(digest, 'hex'));
    }
}
