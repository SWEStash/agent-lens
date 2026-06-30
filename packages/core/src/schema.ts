/**
 * Agent Lens — normalized, agent-agnostic data model (SQLite DDL).
 *
 * Design notes
 * - Agent-agnostic: Claude Code is one *source adapter*. Adding another agent later means a new
 *   adapter that emits rows for these same tables — no schema change (see ADR-003).
 * - Event-grained source of truth: every transcript line becomes a row in `events`, keyed by its
 *   stable `uuid`. Re-ingesting the same event is an UPSERT, so ingesting the mirror plus all
 *   `.versions/` divergence backups deduplicates to the *maximal* history and recovers
 *   compaction-dropped events (see ADR-001 / ADR-002).
 * - Hierarchy: session › turn › event. A "turn" = one user prompt → assistant completion.
 * - `raw_json` keeps the original line verbatim for lossless re-derivation; structured columns are
 *   projections for querying/dashboards. It is stored gzip-compressed as a BLOB (ADR-011) — write via
 *   `packRaw`, read via `unpackRaw` (both in `rawjson.ts`).
 *
 * This module only declares the schema. Connection handling and migrations live in `db.ts`
 * (Phase 2). Bump SCHEMA_VERSION on any DDL change.
 */

export const SCHEMA_VERSION = 8;

export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema/version bookkeeping ------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- An agent *type* (e.g. 'claude-code'). Extensible to other agents. ---------
CREATE TABLE IF NOT EXISTS agents (
  id   TEXT PRIMARY KEY,           -- 'claude-code'
  name TEXT NOT NULL,              -- 'Claude Code CLI'
  kind TEXT NOT NULL DEFAULT 'cli'
);

-- A configured source = a labeled agent *instance* (e.g. account 'personal' --
-- of agent 'claude-code' rooted at ~/.claude). Sessions belong to a source. --
CREATE TABLE IF NOT EXISTS sources (
  id         TEXT PRIMARY KEY,     -- the (unique) label, e.g. 'personal'
  label      TEXT NOT NULL,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  config_dir TEXT
);

-- A project = a working directory a session ran in. ------------------------
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,    -- stable hash of (agent_id, path)
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  path        TEXT NOT NULL,       -- decoded absolute cwd
  encoded_dir TEXT,                -- original '-home-...' archive dir name
  first_seen  TEXT,                -- ISO8601
  last_seen   TEXT,
  UNIQUE (agent_id, path)
);

-- A session = one transcript file (sessionId). -----------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,   -- sessionId (UUID)
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  source_id         TEXT REFERENCES sources(id),
  project_id        TEXT REFERENCES projects(id),
  slug              TEXT,
  ai_title          TEXT,
  cli_version       TEXT,
  entrypoint        TEXT,
  git_branch        TEXT,
  is_sidechain      INTEGER NOT NULL DEFAULT 0,  -- 1 = subagent thread
  spawn_parent_id   TEXT,                          -- structural parent from path (<parent>/subagents/…); raw link hint, set at ingest
  workflow_run_id   TEXT,                           -- for a Workflow-tool subagent: its run id (wf_<id>) from the path; groups fan-out by run
  parent_session_id TEXT REFERENCES sessions(id), -- spawning session (subagents only); derived in rebuildDerived
  parent_turn_id    TEXT REFERENCES turns(id),     -- the turn that spawned this subagent
  started_at        TEXT,               -- ISO8601 of first event
  ended_at          TEXT,               -- ISO8601 of last event
  duration_ms       INTEGER,
  event_count       INTEGER NOT NULL DEFAULT 0,
  turn_count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workflow_run ON sessions(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent_turn ON sessions(parent_turn_id);

-- A turn = user prompt -> assistant completion within a session. ------------
CREATE TABLE IF NOT EXISTS turns (
  id              TEXT PRIMARY KEY,      -- hash(session_id, seq)
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  seq             INTEGER NOT NULL,      -- 0-based order within session
  user_event_uuid TEXT,                  -- the originating user event
  prompt_preview  TEXT,                  -- short, for lists (full text in events)
  model           TEXT,                  -- model that answered this turn
  started_at      TEXT,
  ended_at        TEXT,
  duration_ms     INTEGER,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

-- Every transcript line. uuid is the dedup key across archive versions. -----
CREATE TABLE IF NOT EXISTS events (
  uuid         TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  turn_id      TEXT REFERENCES turns(id),
  parent_uuid  TEXT,
  seq          INTEGER,                  -- line order as first observed
  type         TEXT NOT NULL,            -- user | assistant | system | attachment | ...
  role         TEXT,                     -- user | assistant (message.role)
  timestamp    TEXT,                     -- ISO8601
  model        TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  is_meta      INTEGER NOT NULL DEFAULT 0,
  text         TEXT,                     -- flattened text/thinking for search + preview
  raw_json     BLOB NOT NULL,            -- original line, verbatim, gzip-compressed (ADR-011); read via unpackRaw()
  source_file  TEXT                      -- archive path the canonical copy came from
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);

-- Tool invocations (incl. subagents / Task calls). -------------------------
CREATE TABLE IF NOT EXISTS tool_calls (
  id                  TEXT PRIMARY KEY,  -- tool_use id, or hash
  event_uuid          TEXT REFERENCES events(uuid),
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  turn_id             TEXT REFERENCES turns(id),
  tool_name           TEXT NOT NULL,     -- Edit, Write, Bash, Skill, Task, ...
  caller              TEXT,
  skill_name          TEXT,              -- when tool_name = Skill
  skill_id            TEXT REFERENCES skills(id), -- the specific skill *version* this call fired (content hash); set in rebuildDerived
  agent_type          TEXT,              -- subagent type (toolUseResult.agentType)
  spawned_session_id  TEXT,              -- for Task/Agent: the subagent session id ('agent-'||agentId)
  workflow_run_id     TEXT,              -- for Workflow: the run id (toolUseResult.runId, e.g. wf_<id>) — ties the run to its subagents
  workflow_name       TEXT,              -- for Workflow: the workflow name (toolUseResult.workflowName)
  resolved_model      TEXT,
  status              TEXT,              -- success | error | ...
  total_duration_ms   INTEGER,
  total_tokens        INTEGER,
  total_tool_use_count INTEGER,
  input_json          TEXT,              -- tool input, verbatim
  result_summary      TEXT               -- short result projection (no secrets dumped wholesale)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_skill ON tool_calls(skill_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_skill_id ON tool_calls(skill_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_spawned ON tool_calls(spawned_session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_workflow_run ON tool_calls(workflow_run_id);

-- Skill *versions* (content-addressed). A skill firing injects the full SKILL.md body into the
-- transcript as an isMeta user event (begins "Base directory for this skill: …", then the body,
-- then a trailing "ARGUMENTS: …" block). That body is the only real skill content available (the
-- trace carries no description/created_at). We identify a version by hashing the *normalized* body
-- (Base-directory line + per-call ARGUMENTS block stripped, trailing whitespace trimmed) so the same
-- content from either install / any args is one version, and a content change shows as a new row.
-- Linked from tool_calls.skill_id in rebuildDerived. See plan: content-addressed skill versioning.
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,   -- sha1 of name + NUL + normalized_body
  name        TEXT NOT NULL,
  base_dir    TEXT,               -- last-seen base directory (informational; NOT part of the hash)
  body        TEXT NOT NULL,      -- normalized SKILL.md body (Base-dir line + ARGUMENTS block stripped)
  summary     TEXT,               -- first heading/intro line, for list + detail display
  body_bytes  INTEGER,
  first_seen  TEXT,               -- earliest firing timestamp (MIN across firings)
  last_seen   TEXT                -- latest firing timestamp (MAX across firings)
);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

-- Token usage at the assistant-response grain. Cost derived later from model. --
-- One API response is logged across multiple JSONL lines (one per content block: text + each
-- tool_use), and Claude Code stamps the SAME usage object on every line. We dedup at the response
-- grain via the unique (session_id, message_id) index so a response's tokens are counted ONCE, not
-- once per content block (which over-counted tokens ~2.3x and cost ~3x). event_uuid stays the PK
-- (the row is attached to whichever content-block event won the insert). --
CREATE TABLE IF NOT EXISTS token_usage (
  event_uuid                  TEXT PRIMARY KEY REFERENCES events(uuid),
  session_id                  TEXT NOT NULL REFERENCES sessions(id),
  turn_id                     TEXT REFERENCES turns(id),
  message_id                  TEXT,              -- Anthropic response id (msg_…); dedup key
  model                       TEXT,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  service_tier                TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
-- Partial so rare usage rows lacking a message_id (e.g. <synthetic>) don't collide on NULL. --
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_msg
  ON token_usage(session_id, message_id) WHERE message_id IS NOT NULL;

-- Heuristic classification (category + complexity), re-runnable. -----------
-- scope: 'session' | 'turn'; target_id references that entity. -------------
CREATE TABLE IF NOT EXISTS classifications (
  scope             TEXT NOT NULL,       -- 'session' | 'turn'
  target_id         TEXT NOT NULL,
  category          TEXT,                -- feature | bugfix | refactor | docs | ops | review | ...
  complexity_score  REAL,
  complexity_band   TEXT,                -- trivial | small | medium | large | xl
  signals_json      TEXT,               -- inputs used, for transparency/repro
  classifier_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, target_id)
);

-- Idempotent ingest bookkeeping per archive file. --------------------------
CREATE TABLE IF NOT EXISTS ingest_state (
  file_path       TEXT PRIMARY KEY,
  size            INTEGER,
  mtime_ms        INTEGER,
  sha256          TEXT,
  events_ingested INTEGER NOT NULL DEFAULT 0,
  ingested_at     TEXT
);

-- Full-text search over event text (contentless external-content FTS). ------
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text,
  content='events',
  content_rowid='rowid'
);

-- Keep FTS in sync with events. --------------------------------------------
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events
WHEN old.text IS NOT new.text BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;
