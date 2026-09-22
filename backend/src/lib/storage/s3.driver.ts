import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import { safeExtFromMime } from "./mime-ext.js";
import type { StorageDriver, StoredFile, UploadInput } from "./types.js";

/**
 * Driver S3 (AWS) e compatíveis (MinIO, Cloudflare R2, DigitalOcean Spaces).
 * Configurável via S3_ENDPOINT / S3_FORCE_PATH_STYLE.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl?: string;

  constructor() {
    if (!env.S3_BUCKET || !env.S3_REGION) {
      throw new Error(
        "Driver S3 requer S3_BUCKET e S3_REGION configurados no .env",
      );
    }
    this.bucket = env.S3_BUCKET;
    this.publicUrl = env.S3_PUBLIC_URL?.replace(/\/$/, "");

    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            }
          : undefined, // permite credenciais via IAM role/ambiente
    });
  }

  private buildPublicUrl(key: string): string {
    if (this.publicUrl) return `${this.publicUrl}/${key}`;
    if (env.S3_ENDPOINT) {
      const base = env.S3_ENDPOINT.replace(/\/$/, "");
      return env.S3_FORCE_PATH_STYLE
        ? `${base}/${this.bucket}/${key}`
        : `${base}/${key}`;
    }
    return `https://${this.bucket}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
  }

  async upload(input: UploadInput): Promise<StoredFile> {
    const ext = safeExtFromMime(input.mimeType);
    const key = `${input.folder.replace(/\/$/, "")}/${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.buffer,
        ContentType: input.mimeType,
      }),
    );

    return {
      key,
      url: this.buildPublicUrl(key),
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async download(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`Objeto vazio no S3: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  keyFromUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const prefix = new URL(this.buildPublicUrl("")).pathname;
    const base = new URL(this.buildPublicUrl("x"));
    if (parsed.host !== base.host) return null;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const key = decodeURIComponent(parsed.pathname.slice(prefix.length));
    return key || null;
  }
}
