-- Converte tokens antigos (hex) para o padrão NEO-0A0AA0
CREATE OR REPLACE FUNCTION gen_neo_access_token() RETURNS text AS $$
DECLARE
  d text := '0123456789';
  l text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
BEGIN
  RETURN 'NEO-' ||
    substr(d, (floor(random() * 10)::int + 1), 1) ||
    substr(l, (floor(random() * 26)::int + 1), 1) ||
    substr(d, (floor(random() * 10)::int + 1), 1) ||
    substr(l, (floor(random() * 26)::int + 1), 1) ||
    substr(l, (floor(random() * 26)::int + 1), 1) ||
    substr(d, (floor(random() * 10)::int + 1), 1);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  r RECORD;
  new_token text;
  attempts int;
  taken boolean;
BEGIN
  FOR r IN SELECT id FROM workers WHERE "qrHash" NOT LIKE 'NEO-%' LOOP
    attempts := 0;
    LOOP
      attempts := attempts + 1;
      new_token := gen_neo_access_token();
      taken := EXISTS (SELECT 1 FROM workers w WHERE w."qrHash" = new_token);
      EXIT WHEN NOT taken OR attempts > 100;
    END LOOP;
    IF attempts > 100 THEN
      RAISE EXCEPTION 'Não foi possível gerar token único para worker %', r.id;
    END IF;
    UPDATE workers SET "qrHash" = new_token WHERE id = r.id;
  END LOOP;
END $$;

DROP FUNCTION gen_neo_access_token();
