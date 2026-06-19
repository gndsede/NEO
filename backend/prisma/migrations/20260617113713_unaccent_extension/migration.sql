-- Habilita a extensão unaccent do Postgres. Usada nos filtros de busca
-- para tornar a pesquisa insensível a acentuação (ex.: "jose" casa com "José").
CREATE EXTENSION IF NOT EXISTS unaccent;
