-- API keys, service accounts and the keys that sign short-lived tokens.
-- Add-only: never edit this file after release, add a new numbered file instead.

-- A named identity that is not a person. It belongs to the workspace, so its keys keep working
-- when the member who made it leaves. Deleting one sets deleted_at and revokes its keys.
CREATE TABLE service_accounts (
  id               TEXT    PRIMARY KEY,
  org_id           TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  role             TEXT    NOT NULL,           -- admin | member | viewer
  created_by       TEXT    NOT NULL,
  created_by_label TEXT,
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);
CREATE INDEX service_accounts_org ON service_accounts (org_id, created_at);
CREATE UNIQUE INDEX service_accounts_name ON service_accounts (org_id, lower(name)) WHERE deleted_at IS NULL;

-- One row per key. The key itself is never stored: key_hash is the SHA-256 of the full key.
-- prefix is the first part of the key (`ts_live_` plus 8 characters). It is not secret; it is
-- shown in lists and used to find the row before the hash is compared.
CREATE TABLE api_keys (
  id                 TEXT    PRIMARY KEY,
  org_id             TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  kind               TEXT    NOT NULL,         -- personal | service
  user_id            TEXT,                     -- personal keys: the member the key stops working with
  service_account_id TEXT,                     -- service keys: the account the key acts as
  prefix             TEXT    NOT NULL,
  key_hash           TEXT    NOT NULL,
  scopes             TEXT    NOT NULL,         -- JSON array, for example ["links:read"]
  role               TEXT    NOT NULL,         -- admin | member | viewer
  expires_at         INTEGER,
  created_by         TEXT    NOT NULL,
  created_by_label   TEXT,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  last_used_ip       TEXT,
  revoked_at         INTEGER,
  revoked_reason     TEXT,                     -- manual | rotated | member_removed | service_account_deleted
  rotated_from       TEXT,                     -- id of the key this one replaced
  replaced_by        TEXT                      -- id of the key that replaced this one
);
CREATE UNIQUE INDEX api_keys_prefix ON api_keys (prefix);
CREATE INDEX api_keys_org ON api_keys (org_id, created_at);
CREATE INDEX api_keys_user ON api_keys (org_id, user_id);
CREATE INDEX api_keys_service ON api_keys (org_id, service_account_id);

-- Key pairs that sign short-lived tokens. One install has one set, shared by every workspace.
-- private_enc is the private key encrypted with a key derived from AUTH_SECRET; it is cleared
-- when the key is retired. Retired public keys stay until every token they signed has expired.
CREATE TABLE jwt_signing_keys (
  kid         TEXT    PRIMARY KEY,
  alg         TEXT    NOT NULL,
  public_jwk  TEXT    NOT NULL,
  private_enc TEXT,
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER
);
