-- Calificaciones y sugerencias de Colevana. Solo el Worker escribe aqui, y
-- siempre con el usuario sacado de una sesion de Kick firmada por el Worker.
CREATE TABLE IF NOT EXISTS ratings (
  content_key   TEXT NOT NULL,
  kick_username TEXT NOT NULL,
  content_title TEXT NOT NULL DEFAULT '',
  rating        REAL NOT NULL CHECK (rating BETWEEN 0.5 AND 5 AND rating * 2 = CAST(rating * 2 AS INTEGER)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (content_key, kick_username)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kick_username TEXT NOT NULL,
  message       TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS suggestions_by_user ON suggestions (kick_username, created_at);
