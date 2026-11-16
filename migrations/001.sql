CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE cursor (
  id INTEGER PRIMARY KEY CHECK(id = 1), validity TEXT NOT NULL, last_uid INTEGER NOT NULL,
  baseline_at INTEGER NOT NULL, reconcile TEXT, scan_at INTEGER
);
CREATE TABLE mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, validity TEXT NOT NULL, uid INTEGER NOT NULL,
  received INTEGER NOT NULL, envelope TEXT NOT NULL, body TEXT, translation TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', ignored INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, issue TEXT,
  UNIQUE(validity, uid)
);
CREATE INDEX mail_queue ON mails(status, next_at, id);
CREATE TABLE analysis_cache (
  mail INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(mail, key)
);
CREATE TABLE drafts (
  id INTEGER NOT NULL, version INTEGER NOT NULL, mail INTEGER NOT NULL REFERENCES mails(id),
  created INTEGER NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT', PRIMARY KEY(id, version)
);
CREATE TABLE confirmations (
  draft INTEGER NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
  owner TEXT NOT NULL, chat TEXT NOT NULL, preview_event TEXT NOT NULL, expires INTEGER NOT NULL,
  token_hash TEXT NOT NULL, used INTEGER,
  PRIMARY KEY(draft, version), FOREIGN KEY(draft, version) REFERENCES drafts(id, version)
);
CREATE TABLE sends (
  draft INTEGER NOT NULL, version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'QUEUED', raw TEXT, message_id TEXT, result TEXT,
  touched INTEGER NOT NULL, copy TEXT, PRIMARY KEY(draft, version),
  FOREIGN KEY(draft, version) REFERENCES drafts(id, version)
);
CREATE TABLE notices (
  key TEXT PRIMARY KEY, mail INTEGER REFERENCES mails(id), text TEXT NOT NULL, file_name TEXT,
  state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, touched INTEGER NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0, platform_id TEXT, issue TEXT
);
CREATE INDEX notice_queue ON notices(state, next_at, touched);
CREATE TABLE inbound_events (event TEXT PRIMARY KEY, received INTEGER NOT NULL);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, action TEXT NOT NULL, ref TEXT NOT NULL, result TEXT NOT NULL
);
