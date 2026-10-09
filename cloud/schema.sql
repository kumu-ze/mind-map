CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL, display_name text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('user','admin')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
 id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 created_by uuid REFERENCES users(id), expires_at timestamptz NOT NULL,
 used_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS folders (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS maps (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 folder_id uuid REFERENCES folders(id) ON DELETE SET NULL, title text NOT NULL,
 data jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS revisions (
 id uuid PRIMARY KEY, map_id uuid NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
 version integer NOT NULL, title text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(map_id, version)
);
CREATE TABLE IF NOT EXISTS shares (
 id uuid PRIMARY KEY, map_id uuid NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
 token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maps_owner_updated ON maps(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS folders_owner ON folders(owner_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS shares_map ON shares(map_id);
