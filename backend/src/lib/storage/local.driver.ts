import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
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

  async download(key: string): Promise<Buffer> {
    return readFile(this.resolveSafe(key));
  }

  keyFromUrl(url: string): string | null {
    // A URL gravada no banco carrega o host do momento do upload
    // (tipicamente `localhost`). Só o caminho importa para achar o arquivo.
    const basePath = new URL(this.publicUrl).pathname.replace(/\/$/, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!parsed.pathname.startsWith(`${basePath}/`)) return null;
    return decodeURIComponent(parsed.pathname.slice(basePath.length + 1));
  }

  /** Impede que uma chave com `..` escape do diretório de uploads. */
  private resolveSafe(key: string): string {
    const full = path.resolve(this.baseDir, key);
    if (full !== this.baseDir && !full.startsWith(this.baseDir + path.sep)) {
      throw new Error("Chave de arquivo fora do diretório de uploads");
    }
    return full;
  }
}
