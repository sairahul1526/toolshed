-- Accounts, sessions, sign-in methods, workspaces and invites.
--
-- The first nine tables are the ones Better Auth reads and writes for the plugins this app turns on
-- (username, two-factor, passkey, organization, admin). Their names, camelCase columns and ISO-8601
-- text dates are Better Auth's own, so they must stay exactly as written here. `auth_codes` is ours
-- and follows the house style (snake_case, integer millisecond times).

CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "username" TEXT UNIQUE,
  "displayUsername" TEXT,
  "twoFactorEnabled" INTEGER,
  -- 'admin' marks an owner of the whole install, 'user' is everyone else.
  "role" TEXT,
  "banned" INTEGER,
  "banReason" TEXT,
  "banExpires" DATE
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "activeOrganizationId" TEXT,
  "impersonatedBy" TEXT
);
CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE "twoFactor" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "secret" TEXT NOT NULL,
  "backupCodes" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "verified" INTEGER,
  "failedVerificationCount" INTEGER,
  "lockedUntil" DATE
);
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");

CREATE TABLE "passkey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "credentialID" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "deviceType" TEXT NOT NULL,
  "backedUp" INTEGER NOT NULL,
  "transports" TEXT,
  "createdAt" DATE,
  "aaguid" TEXT
);
CREATE INDEX "passkey_userId_idx" ON "passkey" ("userId");
CREATE INDEX "passkey_credentialID_idx" ON "passkey" ("credentialID");

-- A workspace. The core reads id, name and slug from this table.
CREATE TABLE "organization" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "logo" TEXT,
  "createdAt" DATE NOT NULL,
  "metadata" TEXT
);

CREATE TABLE "member" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- owner | admin | member | viewer
  "role" TEXT NOT NULL,
  "createdAt" DATE NOT NULL
);
CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");
CREATE INDEX "member_userId_idx" ON "member" ("userId");
-- One membership per person per workspace, whatever two requests race to do.
CREATE UNIQUE INDEX "member_org_user_unique" ON "member" ("organizationId", "userId");

CREATE TABLE "invitation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT,
  -- pending | accepted | canceled
  "status" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "inviterId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organizationId");
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");

-- One-time email codes: sign-in, the first-run claim, joining by invite and changing an email.
-- Only keyed hashes are stored, so a copy of this table cannot be turned back into codes or links.
CREATE TABLE auth_codes (
  id TEXT PRIMARY KEY,
  -- sign-in | claim | invite | email-change
  purpose TEXT NOT NULL,
  -- The lower-cased address the code was sent to.
  email TEXT NOT NULL,
  -- email-change: the user who asked. invite: the invitation id.
  ref TEXT,
  code_hash TEXT NOT NULL,
  -- Hash of the token in the emailed link, when the email has one.
  link_hash TEXT,
  -- Wrong guesses so far. The code stops working at the limit.
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX auth_codes_lookup ON auth_codes (purpose, email, created_at);
CREATE UNIQUE INDEX auth_codes_link ON auth_codes (link_hash) WHERE link_hash IS NOT NULL;
CREATE INDEX auth_codes_expiry ON auth_codes (expires_at);
