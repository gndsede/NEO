-- Turno de trabalho do colaborador (HH:MM, 24h).
-- Alimenta o registro automático de saída no fim do expediente.
ALTER TABLE "workers" ADD COLUMN "shiftStart" TEXT;
ALTER TABLE "workers" ADD COLUMN "shiftEnd"   TEXT;
