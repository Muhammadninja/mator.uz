import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { CloudinaryFolder } from '../common/image.constants';

/** A successfully uploaded asset: its public URL and the id used to delete it. */
export interface UploadedImage {
  url: string;
  publicId: string;
}

@Injectable()
export class CloudinaryService implements OnModuleInit {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    cloudinary.config({
      cloud_name: this.config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.getOrThrow<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
    });
  }

  async uploadBuffer(buffer: Buffer, folder: string = CloudinaryFolder.PRODUCTS): Promise<UploadedImage> {
    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ folder, resource_type: 'image', format: 'png' }, (err, result: UploadApiResponse) => {
          if (err) return reject(new Error(`Cloudinary: ${err.message ?? JSON.stringify(err)}`));
          if (!result) return reject(new Error('Cloudinary: no result returned'));
          resolve({ url: result.secure_url, publicId: result.public_id });
        })
        .end(buffer);
    });
  }

  /**
   * Delete the given assets by public_id. Best-effort: a failure to delete one
   * asset is logged and does not throw, so callers (e.g. cancelling a pending
   * product) never fail because cleanup couldn't reach Cloudinary.
   */
  async deleteAssets(publicIds: string[]): Promise<void> {
    await Promise.all(
      publicIds.map(async (publicId) => {
        try {
          await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
        } catch (err) {
          this.logger.warn(
            `Failed to delete Cloudinary asset "${publicId}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }
}
