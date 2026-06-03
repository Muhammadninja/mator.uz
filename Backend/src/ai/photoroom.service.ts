// src/ai/photoroom.service.ts
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';

const PHOTOROOM_ENDPOINT = 'https://sdk.photoroom.com/v1/segment';

export class PhotoroomService {
  private readonly apiKey: string;

  constructor() {
    const key = process.env.PHOTOROOM_API_KEY;
    if (!key) throw new Error('PHOTOROOM_API_KEY is not set');
    this.apiKey = key;
  }

  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    const form = new FormData();
    form.append('image_file', imageBuffer, {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    });

    try {
      const response = await axios.post<ArrayBuffer>(PHOTOROOM_ENDPOINT, form, {
        headers: {
          ...form.getHeaders(),
          'x-api-key': this.apiKey,
        },
        responseType: 'arraybuffer',
        timeout: 30_000,
      });

      // /v1/segment returns a transparent PNG — composite it onto a white background
      const transparentPng = Buffer.from(response.data);
      const { width, height } = await sharp(transparentPng).metadata();

      const whiteBg = await sharp({
        create: {
          width: width ?? 1000,
          height: height ?? 1000,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([{ input: transparentPng, blend: 'over' }])
        .png()
        .toBuffer();

      return whiteBg;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`PhotoroomService: background removal failed — ${msg}`);
    }
  }
}
