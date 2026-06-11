import { env } from "../../config/env.js";
import { LocalStorageDriver } from "./local.driver.js";
import type { StorageDriver } from "./types.js";

export type { StorageDriver, StoredFile, UploadInput } from "./types.js";

/**
 * Factory do storage. Resolve o driver conforme STORAGE_DRIVER.
 * Os drivers S3/Supabase são importados dinamicamente para não exigir
 * suas dependências quando não estiverem em uso.
 */
let instance: StorageDriver | undefined;

export async function getStorage(): Promise<StorageDriver> {
  if (instance) return instance;

  switch (env.STORAGE_DRIVER) {
    case "s3": {
      const { S3StorageDriver } = await import("./s3.driver.js");
      instance = new S3StorageDriver();
      break;
    }
    case "supabase": {
      const { SupabaseStorageDriver } = await import("./supabase.driver.js");
      instance = new SupabaseStorageDriver();
      break;
    }
    case "local":
    default:
      instance = new LocalStorageDriver();
      break;
  }

  return instance;
}
