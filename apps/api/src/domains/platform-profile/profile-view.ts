import type { PlatformProfileRecord } from '@/ports/repositories';

export function platformProfileView(profile: PlatformProfileRecord): {
    displayName: string;
    avatarUrl: string | null;
    homeCity: string | null;
    bio: string;
    updatedAt: number;
} {
    return {
        displayName: profile.display_name,
        avatarUrl: profile.avatar_external_url || (profile.avatar_object_key
            ? `/api/platform/me/avatar?v=${profile.updated_at}`
            : null),
        homeCity: profile.home_city,
        bio: profile.bio,
        updatedAt: profile.updated_at
    };
}
