# Deploy — Vercel (frontend) + Railway (backend)

Ordem importa: **backend primeiro**. O frontend precisa da URL pública da API
no momento do *build*, então subir a Vercel antes é retrabalho garantido.

---

## 0. De onde vem cada valor

Nada aqui se inventa. Cada variável tem uma origem única:

| Valor | Nasce em | Você faz |
|---|---|---|
| URL da API (`https://...up.railway.app`) | Railway | **gera** o domínio (não existe até você clicar) |
| `DATABASE_URL` | Railway | **referencia** o Postgres, nunca copia a senha |
| `JWT_SECRET`, `BADGE_HASH_SECRET`, `ENCRYPTION_KEY` | sua máquina | **gera** com `openssl`/`node` |
| Domínio do painel (`https://...vercel.app`) | Vercel | **lê** o que a Vercel já criou |
| `CORS_ORIGIN`, `FRONTEND_URL` | — | = domínio da Vercel |
| `VITE_API_BASE_URL` | — | = URL do Railway **+ `/api`** |

As duas últimas linhas são a ligação entre os serviços: cada lado precisa saber
o endereço do outro. É por isso que o backend sobe primeiro.

### 0.1 A URL do Railway

Ela **não existe** até ser gerada — um serviço novo só é acessível pela rede
interna do projeto.

1. <https://railway.app/dashboard> → abra o projeto → clique no serviço do backend
2. Aba **Settings** → seção **Networking** → **Public Networking**
3. **Generate Domain** → ele pergunta a porta: informe **3333** (`EXPOSE 3333` no Dockerfile)
4. Copie o que aparecer: `algumacoisa.up.railway.app`

Se já houver um domínio listado ali, é esse — não gere outro.

### 0.2 `DATABASE_URL`

Não copie a connection string do Postgres na mão: ela muda quando a Railway
rotaciona a senha, e aí o backend cai.

1. O projeto precisa ter um serviço Postgres. Se não tiver: **+ New** → **Database** → **Add PostgreSQL**
2. No serviço do **backend** → aba **Variables** → **New Variable**
3. Nome `DATABASE_URL`, valor `${{Postgres.DATABASE_URL}}`

Essa sintaxe é uma *referência*: a Railway resolve sozinha e mantém atualizada.
Se o serviço de banco tiver outro nome, troque `Postgres` pelo nome dele.

### 0.3 Os segredos

Gere na sua máquina — nunca reaproveite de outro ambiente:

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
```

```bash
node -e "console.log('BADGE_HASH_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

```bash
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

Antes de gerar os dois últimos, leia "Segredos — o que pode e o que não pode ser
rotacionado" mais abaixo. Cole cada um em Railway → serviço backend →
**Variables** → **New Variable**. Nada disso vai para o repositório.

### 0.4 O domínio da Vercel

1. <https://vercel.com/dashboard> → abra o projeto do frontend
2. O domínio de produção aparece no topo da aba **Project**; a lista completa
   fica em **Settings** → **Domains**

Esse valor alimenta `CORS_ORIGIN` e `FRONTEND_URL` no Railway. Use sempre o
domínio fixo do projeto — as URLs de preview mudam a cada deploy.

### 0.5 Onde ficam as variáveis da Vercel

Vercel → projeto → **Settings** → **Environment Variables**. E o redeploy, que é
o passo que faz a variável valer: aba **Deployments** → menu `...` do deploy
mais recente → **Redeploy** → **desmarque** *Use existing Build Cache*.

---

## 1. Railway — backend

Serviço: Docker, a partir do `Dockerfile` na **raiz** do repositório
(ele copia de `backend/`). Root Directory do serviço = raiz do repo, não `backend/`.

### Variáveis (Railway → seu serviço → Variables)

| Variável | Valor | Observação |
|---|---|---|
| `NODE_ENV` | `production` | |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | referência ao Postgres do projeto, não cole a string |
| `CORS_ORIGIN` | `https://neo-frontend-psi.vercel.app` | sem barra no final; vários domínios separados por vírgula |
| `FRONTEND_URL` | `https://neo-frontend-psi.vercel.app` | usada nos links de e-mail de convite |
| `TRUST_PROXY` | `1` | Railway fica atrás de load balancer; sem isso o rate limit por IP não funciona |
| `JWT_SECRET` | gerar | `openssl rand -hex 48` |
| `BADGE_HASH_SECRET` | gerar | ⚠️ ver "Segredos" abaixo |
| `ENCRYPTION_KEY` | gerar | hex de 64 chars. ⚠️ ver "Segredos" abaixo |
| `RESEND_API_KEY` | opcional | sem ela, e-mails apenas não são enviados |
| `NOTIFICATION_FROM_EMAIL` | opcional | remetente dos e-mails |

`PORT` **não** deve ser definida: a Railway injeta a dela.

### Storage

`STORAGE_DRIVER` fica em `local` por padrão, e o disco do container é efêmero —
**uploads somem a cada deploy**. Para valer em produção, defina
`STORAGE_DRIVER=s3` (ou `supabase`) com as credenciais correspondentes, e
`S3_PUBLIC_URL` para a URL pública dos arquivos.

### Segredos — o que pode e o que não pode ser rotacionado

- `JWT_SECRET` — pode trocar à vontade. Efeito: todo mundo é deslogado.
- `BADGE_HASH_SECRET` — trocar **invalida todos os QR codes de crachá já
  impressos**. Só gere um novo se ainda não houver crachá em circulação.
- `ENCRYPTION_KEY` — trocar torna **CPF/RG já gravados ilegíveis**, sem volta.
  Só gere uma nova se o banco de produção estiver vazio. Se já existir dado,
  reutilize exatamente a chave atual e guarde um backup dela.

### Verificar

```bash
curl -i https://<seu-servico>.up.railway.app/health
```

Precisa responder `200`. Se não responder, o resto não vai funcionar — confira
os logs de boot: o backend valida as variáveis e falha explicando qual faltou.

---

## 2. Vercel — frontend

Root Directory do projeto = `frontend/`.

### Variável (Vercel → Settings → Environment Variables)

| Variável | Valor | Ambientes |
|---|---|---|
| `VITE_API_BASE_URL` | `https://<seu-servico>.up.railway.app/api` | Production, Preview, Development |

Detalhes que causam 90% dos problemas aqui:

- O sufixo **`/api` faz parte do valor**. Sem ele, toda chamada vira 404.
- **Sem barra no final.**
- `https://`, nunca `http://` — a página é HTTPS e o navegador bloqueia
  requisição HTTP por Mixed Content (foi exatamente o erro original).
- O Vite injeta esse valor **no build**. Alterar a variável no painel não muda
  nada sozinho: é preciso **Redeploy**, e com a opção *"Use existing Build
  Cache"* DESMARCADA.

### Verificar

Abra `/login`, envie o formulário e olhe a aba Network: a requisição deve ir
para `https://<railway>/api/auth/login`. Se aparecer `:3333` na URL, a variável
não entrou no build.

---

## 3. App da catraca — Expo/EAS

O app é o **terceiro** consumidor da URL do Railway, e o único que não avisa
quando ela muda: o valor é congelado dentro do APK no momento do build.

### Variável (`app-catraca/eas.json`)

| Onde | Valor | Observação |
|---|---|---|
| `build.preview.env.EXPO_PUBLIC_API_URL` | `https://<seu-servico>.up.railway.app` | **sem** `/api` — o app concatena sozinho |
| `build.production.env.EXPO_PUBLIC_API_URL` | idem | idem |
| `build.development` | não define | de propósito: o dev client descobre o IP da máquina na rede local |

Diferença que mais confunde: o frontend web quer a URL **com** `/api`, o app
quer **sem**. `src/lib/config.ts` monta `API_URL = ${API_BASE_URL}/api`.

### Ao trocar o serviço do Railway

Gerar um domínio novo (ou recriar o serviço) **desvincula o app** silenciosamente:
os builds antigos continuam chamando o endereço morto e o Railway responde
`Application not found` em tudo. Depois de trocar a URL:

1. Atualize os dois perfis em `eas.json`.
2. Gere um build novo — `eas build -p android --profile preview`. Alterar o
   `eas.json` não conserta APK já instalado.
3. Redistribua o APK para os dispositivos da portaria.

### Verificar

```bash
curl -s https://<seu-servico>.up.railway.app/api/auth/mobile-login \
  -X POST -H "Content-Type: application/json" -d '{}'
```

Precisa responder `400` com erro de validação (rota viva). `404` com
`Application not found` = domínio morto; `404` puro = URL sem o serviço certo.

---

## 4. Erros comuns e o que significam

| Sintoma | Causa |
|---|---|
| `Mixed Content ... requested an insecure resource http://...:3333/api` | `VITE_API_BASE_URL` ausente no build |
| Tela branca + `VITE_API_BASE_URL não definida no build de produção` | idem, agora falhando de forma explícita |
| `blocked by CORS policy` | domínio do front fora de `CORS_ORIGIN` no Railway |
| `404` em toda chamada | faltou `/api` no fim de `VITE_API_BASE_URL` |
| `401` logo após login funcionar | `JWT_SECRET` mudou entre deploys |
| Uploads somem após deploy | `STORAGE_DRIVER=local` em container efêmero |
| App: `Servidor não respondeu` em tudo, após trocar o Railway | `EXPO_PUBLIC_API_URL` do `eas.json` aponta para domínio morto — build novo obrigatório |
| App: `404` em toda chamada, mas o painel web funciona | URL do app com `/api` no fim (o app já concatena) |
