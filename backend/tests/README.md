# Testes de regressão (backend)

Suíte inicial dos fluxos críticos de observabilidade/segurança
(`X-Request-Id`, envelope de erro, autenticação). Novos testes de fluxo de
negócio (ex.: check-in de acesso, aprovação de documento) devem seguir o
mesmo padrão desta pasta.

## Requisitos

- Roda contra o mesmo Postgres do `DATABASE_URL` usado em desenvolvimento
  (não há banco de teste isolado nesta primeira leva). Suba o Postgres local
  antes de rodar (`docker compose` ou instância local — ver `.env`).
- Cada teste limpa as próprias linhas criadas (ex.: `AuditLog` de tentativas
  de login), identificadas por um e-mail/marcador exclusivo do teste.

## Rodar

```
npm run test
```
