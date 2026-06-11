# AccessHub — Backend

Backend do SaaS de **Gestão de Documentação e Controle de Acesso para Obras e Empreiteiras**.

Stack: **Node.js + Express + TypeScript**, **Prisma** (ORM), **PostgreSQL**, storage plugável (**local / AWS S3 / Supabase**), geração de **QR Code** para crachá.

## Arquitetura

```
src/
├─ config/env.ts            # Validação de variáveis de ambiente (zod, fail-fast)
├─ lib/
│  ├─ prisma.ts             # Singleton do PrismaClient
│  ├─ errors.ts             # AppError + helpers HTTP
│  └─ storage/              # Abstração de storage (driver pattern)
│     ├─ types.ts           # Interface StorageDriver
│     ├─ local.driver.ts    # Disco local (dev)
│     ├─ s3.driver.ts       # AWS S3 / MinIO / R2
│     ├─ supabase.driver.ts # Supabase Storage
│     └─ index.ts           # Factory (getStorage)
├─ middleware/
│  ├─ auth.ts               # JWT (authenticate/authorize) + identidade p/ auditoria
│  ├─ upload.ts             # multipart/form-data (multer, em memória)
│  ├─ async-handler.ts
│  └─ error-handler.ts
├─ utils/access-hash.ts     # HMAC do token de acesso embutido no QR
├─ modules/
│  ├─ auth/                 # Login (JWT)
│  ├─ contractors/          # Empreiteiras (CRUD)
│  ├─ workers/              # Colaboradores (cadastro multipart + crachá)
│  ├─ documents/            # Workflow de aprovação documental + auditoria
│  ├─ badge/                # Geração de crachá (QR base64 + payload p/ PDF)
│  └─ access/               # Catraca: validação do QR + AccessLog
├─ routes.ts                # Router agregado (/api)
├─ app.ts                   # App Express
└─ server.ts                # Bootstrap
```

### Multi-tenancy

Tudo pende de `Company` (a Obra/Cliente). O `companyId` vem do JWT e é aplicado
em todas as queries, isolando os dados por tenant.

### Documento polimórfico

`Document` referencia **Worker OU Contractor** via discriminador `ownerType`
(`WORKER` | `CONTRACTOR`) + FKs nuláveis (`workerId` / `contractorId`). A
coerência é garantida na camada de serviço.

## Como rodar

```bash
cd backend
npm install
cp .env.example .env        # ajuste DATABASE_URL e segredos
npm run prisma:generate     # gera o Prisma Client (não toca no banco)

# === Passo que altera o banco (executar manualmente) ===
npm run prisma:migrate      # cria as tabelas (prisma migrate dev)
npm run db:seed             # popula dados de exemplo

npm run dev                 # sobe a API em http://localhost:3333
```

> O cliente já confirmou: **migrações e seed devem ser executados manualmente** —
> nenhum comando que altera o banco roda automaticamente.

### Credenciais de exemplo (após o seed)

- **E-mail:** `admin@accesshub.dev`
- **Senha:** `admin123`

## Endpoints principais

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/api/auth/login` | Autentica e retorna JWT |
| GET | `/api/contractors` | Lista empreiteiras |
| POST | `/api/workers` | **Cadastro completo do colaborador (multipart)** |
| GET | `/api/workers/:id` | Detalhe do colaborador |
| GET | `/api/workers/:id/badge` | **Payload do crachá (QR base64 + dados p/ PDF)** |
| GET | `/api/workers/:id/badge/qrcode.png` | Imagem PNG do QR Code |
| POST | `/api/documents` | Anexa documento avulso (multipart) |
| PATCH | `/api/documents/:id/approve` | **Aprova documento (auditoria)** |
| PATCH | `/api/documents/:id/reject` | **Rejeita documento (motivo + auditoria)** |
| POST | `/api/access/scan` | Catraca: valida QR e registra acesso |
| GET | `/api/access` | Histórico de acessos |

### Exemplo — cadastro de colaborador (multipart/form-data)

```bash
curl -X POST http://localhost:3333/api/workers \
  -H "Authorization: Bearer <TOKEN>" \
  -F "contractorId=<CONTRACTOR_ID>" \
  -F "fullName=João da Silva" \
  -F "cpf=123.456.789-01" \
  -F "role=Pedreiro" \
  -F "registration=CLB-00482" \
  -F 'documentsMeta=[{"type":"ASO","expiresAt":"2026-12-31"},{"type":"NR_35","expiresAt":"2027-03-14"}]' \
  -F "photo=@./foto.jpg" \
  -F "documents=@./aso.pdf" \
  -F "documents=@./nr35.pdf"
```

> `documentsMeta` é um JSON alinhado **posicionalmente** aos arquivos `documents`.

### Exemplo — workflow de aprovação

```bash
# Aprovar (registra reviewedById + reviewedAt)
curl -X PATCH http://localhost:3333/api/documents/<DOC_ID>/approve \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"expiresAt":"2026-12-31"}'

# Rejeitar (exige motivo)
curl -X PATCH http://localhost:3333/api/documents/<DOC_ID>/reject \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"reason":"ASO ilegível, reenviar"}'
```

### Crachá → PDF

`GET /api/workers/:id/badge` retorna um `BadgePayload` com:

- `access.qrCodeDataUrl`: **QR Code em base64** (`data:image/png;base64,...`);
- dados do colaborador/empreiteira/obra, validade e documentos.

O frontend pode renderizar e exportar com `html2canvas` + `jsPDF`, ou o backend
pode transformar o mesmo payload em PDF (ex.: `pdfkit` / `puppeteer`) sem mudar o contrato.

## Storage

Defina `STORAGE_DRIVER` no `.env`:

- `local` — disco local, servido em `/files` (dev).
- `s3` — AWS S3 / MinIO / Cloudflare R2 (variáveis `S3_*`).
- `supabase` — Supabase Storage (variáveis `SUPABASE_*`).

A aplicação depende apenas da interface `StorageDriver`, então trocar o provedor
não exige mudanças no domínio.
