// Teste de carga do NEO AccessHub — k6 (https://k6.io)
//
// COMO RODAR
//   1. Instale o k6: choco install k6   (ou baixe o .exe em k6.io/docs/get-started/installation)
//   2. Copie load-tests/test-users.example.json para load-tests/test-users.json
//      (esse arquivo é ignorado pelo git) e preencha com contas de um tenant
//      dedicado a teste — NUNCA use contas de usuários reais.
//   3. Rode um cenário por vez, ex.:
//        k6 run -e BASE_URL=https://SEU-BACKEND.up.railway.app -e SCENARIO=login load-test.js
//        k6 run -e BASE_URL=https://SEU-BACKEND.up.railway.app -e SCENARIO=dashboard load-test.js
//        k6 run -e BASE_URL=https://SEU-BACKEND.up.railway.app -e SCENARIO=catraca load-test.js
//   4. Comece com poucos VUs (5-10) e vá subindo — NÃO rode "smoke" e "stress" ao
//      mesmo tempo. Acompanhe o Railway (CPU/RAM/conexões do Postgres) ao vivo.
//   5. Pare imediatamente (Ctrl+C) se a taxa de erro subir ou alguém reportar lentidão.

import http from "k6/http";
import crypto from "k6/crypto";
import { check, sleep } from "k6";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || "http://localhost:3333";
const SCENARIO = __ENV.SCENARIO || "login"; // login | dashboard | catraca

// Credenciais de contas de TESTE (nunca use contas reais). Cada entrada:
// { email, password, totpSecret } — totpSecret é o "secret" (base32) que a
// API devolve no primeiro login do usuário, antes de escanear o QR.
// Gerado automaticamente por backend/scripts/create-load-test-tenant.ts.
const TEST_USERS = JSON.parse(open("./test-users.json"));
const TEST_CONFIG = JSON.parse(open("./test-config.json"));

export const options = {
  scenarios: {
    run: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 5 },   // aquecimento
        { duration: "1m", target: 20 },   // carga moderada
        { duration: "1m", target: 20 },   // sustentada
        { duration: "30s", target: 0 },   // resfriamento
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"], // aborta leitura de sucesso se >5% falhar
    http_req_duration: ["p(95)<1500"],
  },
};

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — implementado na mão porque k6 não roda pacotes npm nativos.
// ---------------------------------------------------------------------------

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return bytes;
}

function bytesToArrayBuffer(bytes) {
  const buf = new ArrayBuffer(bytes.length);
  const view = new Uint8Array(buf);
  bytes.forEach((b, i) => (view[i] = b));
  return buf;
}

function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}

/** Gera o código TOTP de 6 dígitos válido agora, a partir do segredo base32. */
function totp(secretBase32, period = 30, digits = 6) {
  const secretBytes = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / period);

  const counterBytes = new Array(8).fill(0);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const hex = crypto.hmac(
    "sha1",
    bytesToArrayBuffer(secretBytes),
    bytesToArrayBuffer(counterBytes),
    "hex",
  );
  const digest = hexToBytes(hex);

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const otp = (binary % 10 ** digits).toString().padStart(digits, "0");
  return otp;
}

// ---------------------------------------------------------------------------
// Helpers de autenticação
// ---------------------------------------------------------------------------

function pickUser(vuId) {
  if (TEST_USERS.length === 0) {
    throw new Error("Preencha test-users.json antes de rodar (veja test-users.example.json).");
  }
  return TEST_USERS[vuId % TEST_USERS.length];
}

/** Faz login completo (senha + TOTP) e devolve o token JWT. */
function login(user) {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "login" } },
  );
  check(loginRes, { "login 200": (r) => r.status === 200 });
  const body = loginRes.json();

  if (!body.requires2FA && !body.token) {
    return null;
  }
  if (body.token) return body.token;

  const code = totp(user.totpSecret);
  const twoFaRes = http.post(
    `${BASE_URL}/api/auth/login/2fa`,
    JSON.stringify({ preAuthToken: body.preAuthToken, code }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "login_2fa" } },
  );
  check(twoFaRes, { "2fa 200": (r) => r.status === 200 });
  return twoFaRes.json("token");
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

function scenarioLogin() {
  const user = pickUser(__VU);
  const token = login(user);
  check(token, { "token recebido": (t) => !!t });
  sleep(1);
}

function scenarioDashboard() {
  const user = pickUser(__VU);
  const token = login(user);
  if (!token) return;
  const headers = { Authorization: `Bearer ${token}` };

  const reqs = [
    ["GET", `${BASE_URL}/api/users`],
    ["GET", `${BASE_URL}/api/obras`],
    ["GET", `${BASE_URL}/api/access/today-summary`],
  ];
  reqs.forEach(([method, url]) => {
    const res = http.request(method, url, null, { headers, tags: { name: url } });
    check(res, { [`${url} 200`]: (r) => r.status === 200 });
  });
  sleep(1);
}

function scenarioCatraca() {
  const user = pickUser(__VU);
  const token = login(user);
  if (!token) return;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const res = http.post(
    `${BASE_URL}/api/access/scan`,
    JSON.stringify({ qr: TEST_CONFIG.workerQr, direction: "ENTRY" }),
    { headers, tags: { name: "scan" } },
  );
  check(res, { "scan respondeu": (r) => r.status === 200 || r.status === 403 });
  sleep(0.5);
}

export default function () {
  if (SCENARIO === "dashboard") return scenarioDashboard();
  if (SCENARIO === "catraca") return scenarioCatraca();
  return scenarioLogin();
}
