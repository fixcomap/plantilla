-- Color del equipo (#rrggbb): tiñe la app. Por defecto, verde de césped.
ALTER TABLE teams ADD COLUMN color text NOT NULL DEFAULT '#1d6b45';
