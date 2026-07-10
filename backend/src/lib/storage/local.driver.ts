import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { safeExtFromMime } from "./mime-ext.js";
import type { StorageDriver, StoredFile, UploadInput } from "./types.js";

/**
 * Driver de storage em disco local. Voltado a desenvolvimento.
 * Os arquivos são servidos estaticamente pela API em `${LOCAL_STORAGE_PUBLIC_URL}`.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = "local";
  private readonly baseDir = path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);
  private readonly publicUrl = env.LOCAL_STORAGE_PUBLIC_URL.replace(/\/$/, "");

  async upload(input: UploadInput): Promise<StoredFile> {
    const ext = safeExtFromMime(input.mimeType);
    const key = `${input.folder.replace(/\/$/, "")}/${randomUUID()}${ext}`;
    const fullPath = path.join(this.baseDir, key);

    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.buffer);

    return {
      key,
      url: `${this.publicUrl}/${key}`,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    const fullPath = path.join(this.baseDir, key);
    await rm(fullPath, { force: true });
  }

  async getSignedUrl(key: string): Promise<string> {
    return `${this.publicUrl}/${key}`;
  }
}
