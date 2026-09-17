# Plano de Desenvolvimento — Neo AccessHub / Catraca Virtual

**Empresa:** Neo Soluções Civis
**Produto:** SaaS B2B de controle de acesso para canteiros de obras via QR Code
**Documento:** Roadmap detalhado até produto consolidado
**Data:** 2026-06-10
**Versão:** 1.0

---

## Sumário Executivo

| Indicador | Valor |
|---|---|
| **Status atual** | Backend + Web Admin + App Mobile com fluxo completo funcionando em desenvolvimento |
| **Próximo marco crítico** | MVP pilotável em obra real |
| **Prazo até MVP pilotável** | **4 a 5 semanas** |
| **Prazo até 1ª venda paga** | **3 a 4 meses** |
| **Prazo até operação saudável (5–15 clientes)** | **6 a 9 meses** |
| **Prazo até produto consolidado** | **12 meses** |
| **Premissa de esforço** | Solo + AI-assisted, ~30h/semana focadas no produto |
| **Investimento financeiro até 1ª venda** | R$ 3.000 a R$ 8.000 (infra + advogado + ferramentas) |

> **Mensagem central:** você está adiantado. Em ~10 dias construímos o que normalmente leva 2–3 meses com 1 dev sênior. A partir de agora, o gargalo deixa de ser tecnologia e vira **validação em campo + processo de vendas**. Cada semana que demorar pra colocar em obra real é uma semana sem aprendizado real do produto.

---

## Onde Estamos Hoje (Baseline)

### Backend (`backend/`)
**Stack:** Express 5 + TypeScript + Prisma 7 + PostgreSQL + JWT + Zod + Multer + Sharp + AWS SDK + Supabase

**Já implementado:**
- Autenticação JWT multi-tenant com perfis e capabilities (`catraca.manage`, `obras.manage`, etc.)
- Modelo de dados completo: Company → Obra → Contractor → Worker + Documents + AccessLog
- Endpoint `POST /api/auth/mobile-login` específico pro app
- Endpoint `POST /api/access/scan` com auto-detecção de ENTRY/EXIT por paridade
- Endpoint `POST /api/access/scan/batch` para fila offline
- Endpoint `GET /api/sync/obra/:obraId` com sync incremental
- Endpoint `GET /api/access` com filtros `mine`, `from`, `direction`, `result`
- Geração de token NEO-0A0AA0 e QR Code
- Storage local com rewrite automático de URLs para LAN
- Validação de exigências documentais (NOT_SENT / PENDING_APPROVAL / REJECTED)
- Validação de pertença à obra ativa no scan
- Cron scheduler para EXIT automático 8h após ENTRY órfã

### Web Admin (`frontend/`)
**Stack:** TanStack Start + React 19 + shadcn/ui + Tailwind + React Query + React Hook Form + Zod

**Estado:** Funcional para cadastros principais. Gerado parcialmente via Lovable.dev.

### App Mobile (`app-catraca/`)
**Stack:** Expo SDK 54 + React Native + TypeScript + React Navigation + expo-camera + expo-secure-store + expo-sqlite (instalado, não usado ainda) + expo-haptics + expo-speech + NetInfo

**Já implementado:**
- Login com validação de capability `catraca.manage`
- Seleção de obra (skip automático se só houver 1)
- Scanner com câmera + leitura de QR + cooldown
- Validação local do prefixo `NEO-` antes de chamar API
- ResultScreen com foto, nome, função, empreiteira, matrícula, ASO, NRs e lista de exigências pendentes
- Voz em PT-BR ("Acesso liberado, entrada"/"saída"/"bloqueado")
- Histórico do turno com filtros server-side
- Indicador visual de conexão online/offline (ping a cada 20s)
- Banner de aviso quando rede ou backend caem

### O que NÃO está pronto
- Modo offline real (SQLite ainda não usado)
- Build de produção (APK/IPA)
- Onboarding self-service de cliente
- Cobrança/Stripe
- Dashboard analytics
- Notificações push
- Documentação legal (Termos, Privacidade, DPA)
- Deploy em produção
- Suporte ao cliente estruturado

---

## Premissas e Cenários

### Cenário-base deste plano
- **Você sozinho** trabalhando no produto, usando ferramentas AI-assisted (Claude Code, Cursor, Lovable, v0)
- **~30 horas semanais focadas** — dividindo com gestão da GND Construções
- Sem freelancer fixo nem time fulltime
- Capital próprio limitado: até R$ 10k pra todo o caminho até primeira venda

### Cenários alternativos (impacto no prazo)

| Cenário | Multiplicador do prazo | Investimento extra |
|---|---|---|
| **Você + 1 freelancer Expo/React parcial (20h/sem)** | **0.6×** (corta 40% do tempo) | R$ 4–8k/mês |
| **Você + 1 dev fulltime + designer parcial** | **0.4×** (corta 60%) | R$ 12–20k/mês |
| **Você 10h/semana ao invés de 30h** | **2.5×** | — |
| **Você 50h/semana focado (sair da GND temporariamente)** | **0.7×** | Custo de oportunidade da GND |

> A maior variável é seu próprio tempo. Tudo abaixo assume o cenário-base. Se você puder dar mais horas, ajuste de cabeça multiplicando pelos fatores.

---

## FASE 1 — MVP Pilotável em Obra Real

**Duração:** 4 a 5 semanas
**Objetivo:** Uma obra de verdade usando o produto todo dia, sem você precisar consertar coisas constantemente. Não precisa estar bonito — precisa funcionar.

---

### Semana 1 — Modo offline (fundação)

**Objetivo da semana:** Banco de dados local no celular preparado pra receber sync e armazenar fila.

#### Entregáveis
1. Esquema SQLite criado e versionado
2. Sync inicial baixando todos colaboradores ativos da obra para o disco do tablet
3. Cache de fotos baixadas e armazenadas localmente

#### Tarefas detalhadas
| # | Tarefa | Esforço |
|---|---|---|
| 1.1 | Criar `src/db/schema.ts` com tabelas `workers_cache`, `scan_queue`, `sync_state` | 3h |
| 1.2 | Criar `src/db/migrations.ts` com versionamento (idempotente, executado no boot) | 2h |
| 1.3 | Criar wrapper `src/db/index.ts` que abre o banco com expo-sqlite | 1h |
| 1.4 | Implementar `syncWorkersFromObra(obraId)` que: baixa do backend, faz upsert na tabela, marca timestamp de last sync | 5h |
| 1.5 | Implementar download de fotos com cache local em `FileSystem.documentDirectory` (uma vez por foto, dedup por URL) | 4h |
| 1.6 | Adicionar tela de "Primeiro sync" mostrando progresso (X de Y colaboradores baixados) | 3h |
| 1.7 | Disparar sync automaticamente após selecionar obra | 2h |
| 1.8 | Botão manual "Sincronizar agora" no scanner | 1h |

**Critério de aceitação:**
- Após logar e selecionar a obra, em até 60 segundos o app tem todos os colaboradores ativos no disco
- Desligando o Wi-Fi e reabrindo o app, ele ainda consegue listar nomes/fotos dos colaboradores
- O tamanho do banco para 200 colaboradores não passa de 50MB

**Tempo total:** ~21h

---

### Semana 2 — Modo offline (operação)

**Objetivo da semana:** Scanner funciona sem internet — validação local + fila persistente que envia quando voltar a conexão.

#### Entregáveis
1. Scan offline validado pelo SQLite local (sem chamar backend)
2. Fila de logs persistida e enviada em background
3. Indicador visual de "X pendentes" e auto-retry

#### Tarefas detalhadas
| # | Tarefa | Esforço |
|---|---|---|
| 2.1 | Modificar `handleScan` no Scanner: tentar validar no SQLite primeiro; se backend está online, sobrescreve com resposta do servidor | 4h |
| 2.2 | Criar lógica local de detecção ENTRY/EXIT (mesma regra do backend, usando logs da fila local) | 3h |
| 2.3 | Verificações offline: status do worker, validade do acesso (a partir do snapshot do sync) | 3h |
| 2.4 | Criar `enqueueScan(item)` que grava em `scan_queue` com clientId UUID local | 2h |
| 2.5 | Worker background: a cada 30s tenta enviar batch dos pendentes ao endpoint `/api/access/scan/batch` | 4h |
| 2.6 | Ao receber resposta do batch, marcar items como sincronizados (pode deletar ou marcar `synced=1`) | 2h |
| 2.7 | Banner persistente no Scanner: "X registros aguardando sincronizar" + última sync OK | 2h |
| 2.8 | Tratamento de conflito: se backend rejeitar (ex: documentação venceu entre o scan e o sync), gravar erro no log local pra revisão | 2h |
| 2.9 | Sync diferencial: usar `?since=timestamp` para baixar só o que mudou desde a última sync | 2h |

**Critério de aceitação:**
- Desligando o Wi-Fi, escanear 10 crachás → cada scan mostra resultado em <1 segundo, com foto e nome
- Religando o Wi-Fi, em até 1 minuto os 10 scans aparecem no histórico do backend
- Nenhum log de acesso é perdido, mesmo fechando o app entre o scan e o restabelecimento da conexão

**Tempo total:** ~24h

---

### Semana 3 — Build de produção + preparação do piloto

**Objetivo da semana:** Gerar APK Android instalável + escolher e equipar a obra piloto.

#### Entregáveis
1. APK gerado via EAS Build e instalado em pelo menos 1 tablet de teste
2. Backend hospedado em ambiente acessível pela internet (não mais só LAN)
3. Cliente piloto identificado e onboarding executado

#### Tarefas detalhadas — Build
| # | Tarefa | Esforço |
|---|---|---|
| 3.1 | Criar conta na Expo (gratuita), instalar `eas-cli` | 30min |
| 3.2 | Configurar `eas.json` com perfis `development`, `preview`, `production` | 1h |
| 3.3 | Substituir os ícones placeholder por logo da Neo Soluções Civis (256x256 + adaptive 432x432) | 2h |
| 3.4 | Configurar splash screen com a marca | 1h |
| 3.5 | Definir `EXPO_PUBLIC_API_URL` para produção no `eas.json` | 30min |
| 3.6 | Rodar `eas build --platform android --profile preview` (produz APK) | 30min + ~20min de build em nuvem |
| 3.7 | Comprar/usar tablet Android 8"+ com câmera traseira decente (~R$ 600–1000) | — |
| 3.8 | Instalar APK no tablet, testar ciclo completo offline + online | 3h |

#### Tarefas detalhadas — Deploy do backend
| # | Tarefa | Esforço |
|---|---|---|
| 3.9 | Criar projeto no Railway (~$5/mês até MVP) ou Fly.io | 1h |
| 3.10 | Provisionar Postgres gerenciado no mesmo provedor | 30min |
| 3.11 | Configurar variáveis de ambiente do backend em produção (DATABASE_URL, JWT_SECRET, etc.) | 1h |
| 3.12 | Configurar bucket no Cloudflare R2 para fotos (mais barato que S3, sem egress fee) | 2h |
| 3.13 | Trocar `STORAGE_DRIVER` para `s3` em produção, usando R2 | 1h |
| 3.14 | Rodar `prisma migrate deploy` no banco de produção | 30min |
| 3.15 | Configurar domínio (ex: `api.neoaccesshub.com.br`) — comprar no Registro.br (~R$ 40/ano) + apontar DNS | 2h |
| 3.16 | Configurar HTTPS (Let's Encrypt via provedor) | 1h |
| 3.17 | Adicionar Sentry para monitoramento de erros (free tier) | 1h |

#### Tarefas detalhadas — Onboarding do piloto
| # | Tarefa | Esforço |
|---|---|---|
| 3.18 | Identificar 1 obra da GND Construções como piloto (interna) ou 1 construtora amiga | 2h (conversas) |
| 3.19 | Reunião com o RH/SegTrab da obra: explicar fluxo, capturar dados de 30–50 colaboradores | 3h |
| 3.20 | Importar colaboradores via planilha (ou cadastrar à mão no admin) | 4h |
| 3.21 | Gerar e imprimir crachás físicos com QR Code (papel laminado serve) | 3h |
| 3.22 | Treinar porteiros (~30min cada, idealmente in loco) | 2h |

**Critério de aceitação:**
- APK instalado em tablet roda offline e online
- Backend em produção responde a `https://api.../api/health`
- Pelo menos 30 colaboradores cadastrados na obra piloto, todos com crachá impresso
- Porteiro consegue usar o app sem ajuda após 1 explicação

**Tempo total:** ~31h

---

### Semana 4 — Piloto em produção + observação

**Objetivo da semana:** App funcionando em obra real, com você observando bugs e UX issues.

#### Entregáveis
1. Pelo menos 100 scans reais por dia na obra piloto
2. Lista de bugs e melhorias coletadas
3. Métricas básicas funcionando (acessos/dia, taxa de bloqueio)

#### Tarefas
| # | Tarefa | Esforço |
|---|---|---|
| 4.1 | Acompanhar o primeiro turno presencialmente (manhã, ~3h) | 3h |
| 4.2 | Criar canal de WhatsApp com porteiros e RH para feedback direto | 30min |
| 4.3 | Implementar painel admin de "Acessos do dia" com filtro por obra (~1 dia) | 6h |
| 4.4 | Resolver bugs urgentes (prováveis: lentidão na câmera com tablets baratos, problemas com fotos grandes, edge cases com nomes longos) | 8–12h |
| 4.5 | Coletar feedback estruturado ao final da semana (questionário 5 perguntas com porteiro e RH) | 2h |

**Critério de aceitação:**
- Porteiro completou a semana sem reclamar do app dificultar o trabalho
- RH conseguiu identificar pelo menos 1 problema de documentação que o sistema bloqueou (validação de valor real)
- Nenhum bug crítico em aberto

**Tempo total:** ~22h

---

### Semana 5 — Iteração e fechamento do MVP

**Objetivo da semana:** Resolver os 5 principais problemas vindos do piloto e declarar MVP pronto.

#### Entregáveis
1. Bugs e UX issues do piloto corrigidos
2. Documentação básica para o cliente (PDF de 4–5 páginas)
3. Decisão: pode vender ou precisa de mais 1–2 semanas?

#### Tarefas
| # | Tarefa | Esforço |
|---|---|---|
| 5.1 | Implementar top 5 melhorias do feedback (ex: "porteiro queria botão grande de "última pessoa", lista de hoje mostra colega que entrou x minutos atrás", etc.) | 12h |
| 5.2 | Tela de configurações no app: trocar senha, sobre, versão, limpar cache | 4h |
| 5.3 | Manual do operador em PDF: como usar o tablet, o que fazer se travar, contato de suporte | 3h |
| 5.4 | Manual do administrador em PDF: como cadastrar colaborador, gerar crachá, ver relatórios | 3h |
| 5.5 | Decisão de go/no-go: o produto está pronto pra cobrar? | 2h |

**Critério de aceitação:**
- Manuais PDF prontos
- 5 melhorias implementadas
- Decisão documentada com argumentos

**Tempo total:** ~24h

---

### Resumo da Fase 1

| Semana | Foco | Horas |
|---|---|---|
| 1 | Offline — fundação (SQLite + sync) | 21h |
| 2 | Offline — operação (fila + retry) | 24h |
| 3 | Build EAS + deploy backend + onboarding piloto | 31h |
| 4 | Piloto em produção + observação | 22h |
| 5 | Iteração final + manuais | 24h |
| **Total** | | **~122h (≈ 5 semanas a 25h/sem)** |

**Custo financeiro estimado da Fase 1:** R$ 1.000 a R$ 2.500
- Tablet Android: R$ 600–1.000
- Railway + R2 + domínio: R$ 100/mês
- EAS Build: gratuito (até 30 builds/mês)
- Sentry: gratuito

---

## FASE 2 — Primeira Venda Paga

**Duração:** 8 semanas (meses 2 e 3 do projeto, contando a partir de hoje)
**Objetivo:** Cobrar boleto/cartão mensal de pelo menos 1 cliente.

### Semanas 6 e 7 — Hardening e observabilidade

**Objetivo:** Ter confiança operacional. Saber o que está quebrado antes do cliente reclamar.

| # | Tarefa | Esforço |
|---|---|---|
| 6.1 | Logs estruturados no backend (substituir morgan por pino) | 4h |
| 6.2 | Dashboard de logs em produção (Better Stack, Logtail ou Railway logs) | 3h |
| 6.3 | Alerta de erro crítico via Telegram/WhatsApp (Sentry → webhook) | 2h |
| 6.4 | Health checks externos (UptimeRobot, gratuito) | 1h |
| 6.5 | Backup automático do Postgres (diário, mantém 7 dias) | 2h |
| 6.6 | Testes manuais documentados em checklist: 30 cenários cobrindo todos os fluxos | 8h |
| 6.7 | Hardening: rate limiting nos endpoints públicos, CSRF onde aplicável, validação de tamanho de upload | 6h |
| 6.8 | Migração 0→1 de cliente novo: roteiro passo-a-passo (criar tenant, importar dados, gerar crachás) | 4h |

**Tempo total:** ~30h

---

### Semanas 8 e 9 — Cobrança e contratos

**Objetivo:** Saber receber dinheiro de forma estruturada.

#### Decisões importantes ANTES dessa semana
- **Modelo de cobrança:** sugiro tier único por colaborador ativo/mês (ex: R$ 4 por colaborador, mínimo R$ 199/mês). Simples de comunicar.
- **Provedor de cobrança:** Asaas (BR, aceita boleto+PIX+cartão, taxa baixa) ou Stripe (cartão internacional + gestão melhor).
- **Plano gratuito?** Não. Cobre desde o primeiro dia mesmo que com desconto. Cliente que paga zero não dá feedback de qualidade.

| # | Tarefa | Esforço |
|---|---|---|
| 7.1 | Integração Asaas: criar cliente, gerar assinatura, webhook de pagamento | 12h |
| 7.2 | Endpoint que recebe webhook e marca tenant como "ativo/inadimplente/cancelado" | 4h |
| 7.3 | Bloqueio gradual: 5 dias após vencimento envia aviso, 15 dias bloqueia o admin web (mas mantém scanner offline rodando 7 dias) | 6h |
| 7.4 | Tela de "Pagamento pendente" no admin web | 3h |
| 7.5 | Página pública de cobrança: histórico, próxima fatura, baixar boleto | 4h |
| 7.6 | Contrato de SaaS (advogado especialista em tech): 2 semanas, R$ 1.500–3.000 (em paralelo) | — |
| 7.7 | Termos de Uso e Política de Privacidade (mesmo advogado) | — |
| 7.8 | Aceite digital dos Termos no primeiro login | 3h |

**Tempo total:** ~32h
**Custo extra:** R$ 1.500–3.000 de advogado

---

### Semanas 10 e 11 — Landing page + funil de vendas

**Objetivo:** Ter algo que você pode mandar pra prospect e ele entende o produto.

| # | Tarefa | Esforço |
|---|---|---|
| 8.1 | Comprar domínio principal: `neoaccesshub.com.br` ou `catracavirtual.com.br` (~R$ 40/ano) | 30min |
| 8.2 | Landing page no Framer, Webflow ou Lovable (~R$ 0–60/mês): hero, problema, solução, prints do app, preço, formulário | 12h |
| 8.3 | Vídeo demo de 90 segundos mostrando o porteiro lendo um crachá (gravar com o celular numa obra) | 4h |
| 8.4 | Formulário de "agendar demo" → CRM simples (Notion, Pipefy ou HubSpot free) | 2h |
| 8.5 | Sequência de e-mail/WhatsApp pós-cadastro (3 mensagens) | 3h |
| 8.6 | Caso de uso documentado da obra piloto: depoimento, números (acessos/dia, fraudes evitadas) | 4h |
| 8.7 | LGPD compliance básica: cookie banner, opt-in marketing, DPO designado (você mesmo no início) | 3h |

**Tempo total:** ~28h

---

### Semanas 12 e 13 — Primeiras demos e venda

**Objetivo:** Fechar pelo menos 1 cliente pagante.

| # | Tarefa | Esforço |
|---|---|---|
| 9.1 | Listar 20 construtoras-alvo (rede da GND + LinkedIn + Sinduscon local) | 3h |
| 9.2 | Sequência de outreach: e-mail/WhatsApp direto para o sócio ou diretor de SST | 5h |
| 9.3 | Realizar 5 demos remotas via Google Meet (45 min cada) | 6h |
| 9.4 | Realizar 3 demos presenciais em canteiros (incluindo deslocamento) | 12h |
| 9.5 | Ajustes pós-feedback dos prospects (provavelmente: relatórios, exportação Excel) | 6h |
| 9.6 | Negociar e fechar primeiro contrato (1-2 meses grátis + desconto vitalício em troca de depoimento e referência) | 4h |

**Tempo total:** ~36h

### Resumo da Fase 2

| Semana | Foco | Horas |
|---|---|---|
| 6–7 | Hardening + observabilidade | 30h |
| 8–9 | Cobrança Asaas + contratos | 32h |
| 10–11 | Landing + funil + LGPD básica | 28h |
| 12–13 | Outreach + demos + fechamento | 36h |
| **Total** | | **~126h (8 semanas a 16h/sem em produto + ~24h/sem em vendas/operação)** |

**Custo financeiro estimado da Fase 2:** R$ 2.500 a R$ 5.000
- Advogado: R$ 1.500–3.000
- Landing + ferramentas: R$ 100–300/mês
- Marketing inicial (LinkedIn Sales Nav, etc.): R$ 0–200/mês
- Domínio + emails profissionais: R$ 200/ano

---

## FASE 3 — Operação Saudável (5 a 15 clientes)

**Duração:** 16 semanas (meses 4 a 9)
**Objetivo:** Crescer de forma previsível, sem você ser gargalo de cada nova venda.

### Mês 4 — Dashboard analytics

| Entregável | Esforço |
|---|---|
| Dashboard no admin web: acessos/dia/obra, top 10 colaboradores que mais entram, taxa de bloqueio, distribuição por hora | 25h |
| Relatório mensal exportável em PDF e Excel | 10h |
| Filtros avançados de busca de acessos (data, obra, função, empreiteira) | 10h |
| Auditoria: trilha de quem aprovou cada documento | 8h |

### Mês 5 — Alertas automáticos

| Entregável | Esforço |
|---|---|
| Job diário detecta ASOs vencendo em 30 / 15 / 7 dias | 6h |
| Job diário detecta NRs vencendo em 30 / 15 / 7 dias | 4h |
| Envio de e-mail para RH (Resend.com ou Postmark, ~R$ 60/mês) | 6h |
| Envio via WhatsApp Cloud API (~R$ 100–300/mês dependendo do volume) | 12h |
| Tela de configuração de notificações por cliente | 8h |
| Webhook genérico (cliente integra com sistema dele) | 6h |

### Mês 6 — Push notifications no app + multi-obra avançado

| Entregável | Esforço |
|---|---|
| Push notifications no app via Expo Push Service (notificação para porteiro: "fim do turno em 1h") | 12h |
| Porteiro troca de obra dentro do turno sem deslogar | 6h |
| Modo "supervisor": admin vê resumo de várias obras simultaneamente | 12h |
| Busca manual por nome de colaborador (quando crachá está rasgado ou perdido) | 8h |
| Foto de selfie ao registrar acesso (anti-fraude leve) | 14h |

### Mês 7 — Integração com folha de pagamento

| Entregável | Esforço |
|---|---|
| Exportação de horas trabalhadas baseada em ENTRY/EXIT (CSV padrão Senior/TOTVS) | 16h |
| Importação de colaboradores via API de sistemas comuns (Senior tem API REST) | 20h |
| Webhook para sistemas externos: "novo colaborador bloqueado" | 6h |
| Documentação técnica da API pública | 10h |

### Mês 8 — Onboarding self-service

| Entregável | Esforço |
|---|---|
| Fluxo de signup: empresa cria conta, paga primeira fatura, recebe acesso | 16h |
| Wizard guiado de primeira configuração (criar obra, definir exigências, importar planilha) | 20h |
| Geração automatizada de crachás em PDF (10 por página, A4) | 8h |
| Vídeos tutoriais embarcados (Loom, ~30 min total) | 6h |

### Mês 9 — Retenção e polimento

| Entregável | Esforço |
|---|---|
| NPS in-app (a cada 90 dias) | 6h |
| Programa de referência (cliente indica outro, ganha 1 mês grátis) | 10h |
| Migração de banco para multi-região (se atingir 15 clientes) | 16h |
| Refatoração de pontos quentes (provavelmente: tabela de access_logs, queries de relatório) | 16h |
| Status page pública (status.neoaccesshub.com.br via Better Stack) | 4h |

### Resumo da Fase 3

| Mês | Tema central | Esforço (h) |
|---|---|---|
| 4 | Analytics | ~50h |
| 5 | Alertas | ~40h |
| 6 | App polish + supervisão | ~50h |
| 7 | Integrações | ~50h |
| 8 | Self-service | ~50h |
| 9 | Retenção e estabilidade | ~50h |
| **Total** | | **~290h (16 semanas a ~18h/sem)** |

**Custo financeiro estimado da Fase 3:** R$ 8.000 a R$ 15.000 (incluindo aumento de infra com clientes pagantes)

---

## FASE 4 — Produto Consolidado (Meses 10 a 12)

**Duração:** 12 semanas
**Objetivo:** Ter um produto que pode ser apresentado a investidores ou escalar com confiança.

### Iniciativas-chave
- **Reconhecimento facial leve** anti-fraude (colaborador passar crachá de colega) — usar AWS Rekognition ou face-api.js
- **App do trabalhador**: vê seu próprio crachá, NRs vencendo, próximos treinamentos
- **Integração com catraca física** (Topdata, Henry, Control iD) via API local
- **API pública documentada** com OpenAPI/Swagger
- **Modo evacuação**: tela vermelha em todos tablets simultaneamente, lista quem está dentro
- **Multi-idioma** (preparar para mercado de Portugal/Angola/Moçambique se viável)
- **Certificação ISO 27001 light** (não a certificação completa, mas controles documentados)

**Esforço total:** ~300h em 12 semanas
**Custo:** depende muito do quanto contratar. Se solo: ~R$ 10–20k em ferramentas/infra.

---

## Riscos Críticos e Como Mitigar

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| **Você não consegue dar 30h/semana** | Alta | Crítico | Definir 3 horários fixos por semana (madrugada, sábado, etc.) e proteger. Contratar freelancer parcial assim que cair abaixo de 20h/sem. |
| **Obra piloto desiste no meio** | Média | Alto | Ter 2 obras-piloto candidatas. Garantir que o primeiro piloto é de uma construtora que você tem controle (ex: GND). |
| **Cliente reclama de funcionalidade do admin web** | Alta | Médio | Priorizar admin web nas próximas iterações. Aceitar dívida técnica do Lovable agora, refatorar quando dor virar grande. |
| **Bug crítico em produção quebrando registros de acesso** | Média | Crítico | Backup diário, Sentry ativo, modo offline robusto (mesmo se backend cair, scanner continua funcionando 7 dias). |
| **LGPD: vazamento de dados de colaboradores** | Baixa | Crítico | Não armazenar CPF no QR Code (já feito). Criptografar fotos no banco. Política de acesso bem definida. Advogado revisar antes de vender. |
| **Concorrência: alguém com mais capital lança similar** | Média | Médio | Foco em integração com folha brasileira e em UX pra porteiro com baixa familiaridade tecnológica — diferenciais difíceis de copiar. |
| **Cliente cancela e quer "seus" dados de volta** | Alta | Baixo | Funcionalidade de exportação completa em CSV/Excel desde o início. Política clara de retenção (manter 30 dias após cancelamento). |
| **Tablet quebra/é roubado** | Alta na vida real | Médio | Documentar processo de provisionar tablet novo em <2h (instalar APK, logar, sync). Cobrar tablet à parte do plano (R$ 800–1500). |

---

## Métricas de Sucesso

### Fim da Fase 1 (semana 5)
- ✅ 1 obra com 30+ colaboradores usando todos os dias
- ✅ >100 scans/dia processados com sucesso
- ✅ Zero bugs críticos em aberto
- ✅ Tempo médio de scan-a-resultado <2 segundos
- ✅ Taxa de falsos bloqueios <5%

### Fim da Fase 2 (semana 13 / mês 3)
- ✅ 1–2 clientes pagantes
- ✅ MRR (Receita Mensal Recorrente) ≥ R$ 500
- ✅ NPS ≥ 50 entre clientes pagantes
- ✅ Churn = 0
- ✅ Capacidade demonstrada de fechar 1 cliente por mês

### Fim da Fase 3 (mês 9)
- ✅ 5–15 clientes pagantes
- ✅ MRR ≥ R$ 5.000
- ✅ Churn mensal <5%
- ✅ Tempo de onboarding self-service <2h
- ✅ NPS ≥ 60
- ✅ <2h de seu tempo direto por cliente/mês

### Fim da Fase 4 (mês 12)
- ✅ 20+ clientes pagantes
- ✅ MRR ≥ R$ 15.000 (~R$ 180k ARR)
- ✅ Crescimento mensal ≥10%
- ✅ Pelo menos 1 caso de uso "estrela" público (vídeo, depoimento)
- ✅ Produto pronto para captação de capital se quiser

---

## Custos Estimados — Acumulado

| Período | Categoria | Valor |
|---|---|---|
| **Fase 1** (5 sem) | Tablet + Railway + R2 + domínio | R$ 1.000–2.500 |
| **Fase 2** (8 sem) | Advogado + landing + email + Asaas setup | R$ 2.500–5.000 |
| **Fase 3** (16 sem) | Aumento de infra + WhatsApp API + marketing | R$ 8.000–15.000 |
| **Fase 4** (12 sem) | AWS Rekognition + ferramentas extras | R$ 10.000–20.000 |
| **Total até 12 meses** | | **R$ 21.500 – 42.500** |

### Sem incluir
- Seu tempo (custo de oportunidade da GND Construções)
- Eventual freelancer (R$ 4–8k/mês se contratar)
- Ferramentas opcionais (Notion, Figma, Linear etc. — soma <R$ 200/mês)

### Receita esperada (cenário conservador)
- Mês 4: R$ 500 MRR (1 cliente)
- Mês 6: R$ 2.000 MRR (3-4 clientes)
- Mês 9: R$ 5.000 MRR (~10 clientes)
- Mês 12: R$ 15.000 MRR (~25 clientes)

**Break-even operacional esperado: entre mês 8 e mês 10.**

---

## Próximos Passos Imediatos (Esta Semana)

Ordene assim:

1. **Hoje** — terminar de validar o cenário "Colaborador é de outra obra" no piloto interno
2. **Amanhã** — começar Semana 1 do plano: criar `src/db/schema.ts` e `migrations.ts` no app
3. **Quarta** — implementar `syncWorkersFromObra` e ver a primeira sync funcionando
4. **Quinta–Sexta** — download de fotos + cache local
5. **Sábado** — testar offline ponta a ponta no celular pessoal

**Cadência semanal sugerida:**
- Segunda 14h: revisar o que ficou da semana anterior, ajustar plano
- Terça/Quarta/Quinta: implementação focada (3h/dia)
- Sexta: testes manuais + correção de bugs
- Sábado de manhã: trabalho profundo em features grandes
- Domingo: descansar

---

## Anexo A — Stack e Custos Operacionais Mensais Estimados

| Componente | Solução | Custo até 5 clientes | Custo 5-20 clientes |
|---|---|---|---|
| Hospedagem backend | Railway | $5–10 | $20–40 |
| Banco PostgreSQL | Railway gerenciado | incluído | $25 |
| Storage de fotos | Cloudflare R2 | $1 | $5 |
| CDN | Cloudflare (free tier) | $0 | $0 |
| Hospedagem do web admin | Vercel (free tier) | $0 | $20 (Pro) |
| Hospedagem landing | Framer/Webflow | $20 | $40 |
| E-mail transacional | Resend | $0 (3k/mês free) | $20 |
| Cobrança | Asaas | R$ 2/transação | R$ 2/transação |
| Domínio | Registro.br | R$ 40/ano | R$ 40/ano |
| Monitoramento | Sentry free | $0 | $26 |
| Logs | Better Stack free | $0 | $25 |
| WhatsApp API | Twilio/Z-API | $0 | R$ 200–500 |
| **Total mensal** | | **~$30 / R$ 150** | **~$200 / R$ 1.000** |

---

## Anexo B — Decisões Pendentes Antes do Mês 3

Antes da primeira venda, decidir:

1. **Nome comercial:** "Neo AccessHub", "Neo Catraca", "Catraca Virtual"? Registrar a marca no INPI.
2. **Modelo de preços:** valor fixo, por colaborador, por obra? Tabela com tiers?
3. **Tablet incluso ou vendido à parte?** Recomendo à parte.
4. **Suporte:** WhatsApp pessoal seu nos 3 primeiros clientes? Quando passa a ter número comercial?
5. **CNPJ separado?** A Neo AccessHub deveria ser pessoa jurídica distinta da GND para fins de cap table/captação futura?
6. **Onde nasce a marca?** Site, Instagram, LinkedIn primeiro?

---

## Anexo C — Histórico de Versões deste Documento

| Versão | Data | Autor | Mudança |
|---|---|---|---|
| 1.0 | 2026-06-10 | — | Versão inicial, baseada no progresso até a Fase 0 |

---

**Última nota:**
> Esse cronograma é um mapa, não um contrato. A realidade vai ajustar tudo. O importante é manter o ritmo: terminar uma semana e começar a próxima sem desistir do plano por inteiro. Se uma tarefa atrasar, role pra próxima semana — não pause o resto.
