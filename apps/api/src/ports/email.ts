export interface PlatformEmailVerificationMessage {
    email: string;
    code: string;
    expiresInMinutes: number;
}

export interface PlatformEmailSender {
    readonly available: boolean;
    sendRegistrationVerification(
        message: PlatformEmailVerificationMessage
    ): Promise<void>;
}

export interface EmailServices {
    platformEmailSender: PlatformEmailSender;
}
