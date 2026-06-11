import { NEO_QR_SPEC } from "../../utils/access-hash.js";

type WorkerWithToken = { qrHash: string };

export function withAccessToken<T extends WorkerWithToken>(worker: T) {
  return {
    ...worker,
    accessToken: worker.qrHash,
  };
}

export function accessTokenPayload(qrHash: string) {
  return {
    accessToken: qrHash,
    qrPayload: qrHash,
    format: NEO_QR_SPEC.pattern,
    spec: NEO_QR_SPEC,
  };
}
