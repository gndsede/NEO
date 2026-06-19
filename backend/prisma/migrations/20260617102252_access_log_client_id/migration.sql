-- Idempotência do batch offline: clientId é gerado pelo app e replicado
-- pelo backend. O reenvio da fila (quando a resposta se perde no caminho)
-- não pode criar logs duplicados.
ALTER TABLE "access_logs" ADD COLUMN "clientId" TEXT;

-- NULLs são distintos no índice único do Postgres, então scans online
-- (sem clientId) não conflitam entre si.
CREATE UNIQUE INDEX "access_logs_companyId_clientId_key"
  ON "access_logs" ("companyId", "clientId");
