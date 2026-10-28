-- Escudo del equipo: cabecera e inicio. Aparte de teams para no cargar la
-- imagen en cada consulta del equipo.
CREATE TABLE team_crests (
    team_id      bigint PRIMARY KEY REFERENCES teams ON DELETE CASCADE,
    image        bytea  NOT NULL,
    content_type text   NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
