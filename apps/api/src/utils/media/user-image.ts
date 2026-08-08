import type { UploadedFile } from '@/ports/http';
import type { ImageProcessor } from '@/ports/media';
import { validateUploadedImage } from '@/utils/media/image-upload';

export interface ConvertedUserImage {
    body: Uint8Array;
    height: number;
    width: number;
}

export async function convertUserImageToWebp(
    file: UploadedFile,
    images: ImageProcessor,
    maxInputBytes: number
): Promise<ConvertedUserImage> {
    if (!file.body.byteLength || file.body.byteLength > maxInputBytes) {
        throw Object.assign(new Error('图片大小超过限制'), { status: 413 });
    }
    const input = await validateUploadedImage(file, images);
    const body = await images.toWebp(file.body, 88);
    if (!body.byteLength || body.byteLength > maxInputBytes) {
        throw Object.assign(new Error('转换后的图片大小超过限制'), { status: 413 });
    }
    const output = await images.validate(body, 'image/webp');
    if (output.format.toLowerCase() !== 'webp') {
        throw Object.assign(new Error('图片转换失败'), { status: 500 });
    }
    return { body, height: input.height, width: input.width };
}
