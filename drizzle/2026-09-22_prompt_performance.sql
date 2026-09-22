-- RMA-P3-02 (v1.65.0) — Prompt-Version-Metrikvergleich (v1.65.0).
-- Append-only: ZWEI neue Tabellen + Indizes/Constraints; keine bestehende
-- Tabelle wird verändert, keine Spalte umgebaut, kein Backfill nötig.
--
-- Hintergrund: Agenten-Prompts wurden versioniert (`agents.version`), aber
-- Prompts selbst waren nicht als immutable Artefakte mit stabilem Hash
-- persistiert und Agentenläufe nicht an Prompt-Versionen gebunden. Es gab
-- keine per-Version-Aggregation von Forecast-Qualität (Brier/Kalibrierung),
-- Attribution und Laufzeit und keinen fairen Vergleich. Operatoren sahen
-- deshalb nicht, ob eine Prompt-Änderung tatsächlich half
-- (Roadmap-Audit 2026-09-20,
-- docs/audits/2026-09-20-roadmap-audit/prompts/PROMPT-P3-02-prompt-performance.md).
--
-- ── Kanonisierung & Hash ──────────────────────────────────────────────────
--   prompt_artifacts.prompt_hash  `pp1:<sha256>` über den LF-kanonisierten
--                                 Text (`\r\n`/`\r` → `\n`, sonst unverändert).
--                                 Stabil über Plattformen/Zeilenenden; eine
--                                 inhaltliche Änderung ändert den Hash
--                                 (Pflicht-Test). `canonical_prompt` ist der
--                                 kanonische Text (nur berechtigt abrufbar).
--
-- ── Provenanz je Lauf ─────────────────────────────────────────────────────
--   agent_prompt_runs referenziert exakt ein Artefakt (oder UNKNOWN bei
--   historischer Lücke). Jedes Feld ist bounded (Rolle/Hash/Fehlercode),
--   keine Secrets, kein Rohtranskript. `idempotency_key` `pr1:<sha256>`
--   macht Retries/Restarts idempotent (kein zweiter Run).
--
-- ── Metriken & Vergleich ──────────────────────────────────────────────────
--   `promptVersion` bindet Forecasts (`forecasts.prompt_version`) und
--   Trades (P1.6 `trade_attribution_entries.source_version`) an die Prompt-
--   Version. Ein Vergleich legt identische Filter (Zeitraum/Horizont/Regime/
--   Entity) über BEIDE Versionen und meldet Coverage/Abstention/Stichprobe.
--   Promotion nur als Empfehlung hinter Human-Gate; ECE-Wächter blockt eine
--   schlechter kalibrierte Variante allein wegen PnLs.
--
-- ── Fail-closed statt Nullwert ────────────────────────────────────────────
--   Unaufgelöste Forecasts (PENDING) zählen nie als Gewinn/Verlust (Brier/ECE
--   nur RESOLVED, Coverage meldet PENDING-Anteil). Unbekannte Kosten/Tokens
--   bleiben NULL, nie 0. Unbekannte Prompt-Versionen sind als UNKNOWN
--   (nicht als 0) sichtbar.
--
-- ── Zeitsemantik ───────────────────────────────────────────────────────────
--   Eventzeit = (forecasts.as_of | agent_prompt_runs.started_at).
--   Verfügbarkeitszeit = forecasts.availability_deadline (Ledger-Deadline).
--   computed_at ist nie Zulässigkeitskriterium (`stored == computed`, aber
--   nie Entscheidungsgrundlage). Alle Metriken filtern nach Ereigniszeit.
--
-- ── Idempotenz und Versionierung ──────────────────────────────────────────
--   prompt_artifacts: UNIQUE(agent_id, version), UNIQUE(agent_id, prompt_hash)
--   agent_prompt_runs: UNIQUE(idempotency_key)  `pr1:<sha256>`
--   Retries mit identischem Key liefern die bestehende Zeile zurück.
--
-- Erklärt mit `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`promptArtifacts`, `agentPromptRuns`); diese Datei ist der äquivalente,
-- idempotente SQL-Pfad für Umgebungen ohne drizzle-kit
-- (z. B. `psql \"$DATABASE_URL\" -f drizzle/2026-09-22_prompt_performance.sql`).
--
-- ── Rollback / Feature-Flag ───────────────────────────────────────────────
-- Der Prompt-Performance-Pfad ist additiv; Agenten-Pipeline, Risiko- und
-- Live-Gate bleiben unverändert. Sichere Rückzugsoption:
--   `PROMPT_PERFORMANCE_ENABLED=false` unterdrückt Artefakt- und Run-
--   Schreiben (bestehende Zeilen bleiben lesbar).
--   Alternativ die beiden Tabellen/Daten ignorieren — kein Gate berührt sie.
--   Trunkierung erfordert manuellen `DROP`-Entscheid des Operators.

-- ── 1. prompt_artifacts — immutable Prompt-Versionen ─────────────────────
CREATE TABLE IF NOT EXISTS prompt_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES agents(id),
  role text NOT NULL,
  version integer NOT NULL,
  prompt_hash text NOT NULL,
  canonical_prompt text NOT NULL,
  template_schema_version text NOT NULL DEFAULT '1',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_artifacts_version_check CHECK (version >= 1),
  CONSTRAINT prompt_artifacts_hash_check CHECK (prompt_hash ~ '^pp1:[0-9a-f]{64}$'),
  CONSTRAINT prompt_artifacts_role_check CHECK (length(role) > 0 AND length(role) <= 64),
  CONSTRAINT prompt_artifacts_template_check CHECK (length(template_schema_version) > 0 AND length(template_schema_version) <= 16)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'prompt_artifacts_agent_version_unique') THEN
    CREATE UNIQUE INDEX prompt_artifacts_agent_version_unique ON prompt_artifacts(agent_id, version);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'prompt_artifacts_agent_hash_unique') THEN
    CREATE UNIQUE INDEX prompt_artifacts_agent_hash_unique ON prompt_artifacts(agent_id, prompt_hash);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'prompt_artifacts_role_idx') THEN
    CREATE INDEX prompt_artifacts_role_idx ON prompt_artifacts(role, version);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'prompt_artifacts_hash_idx') THEN
    CREATE INDEX prompt_artifacts_hash_idx ON prompt_artifacts(prompt_hash);
  END IF;
END $$;

-- ── 2. agent_prompt_runs — Provenanz je LLM-Aufruf ───────────────────────
CREATE TABLE IF NOT EXISTS agent_prompt_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid REFERENCES prompt_artifacts(id),
  agent_id uuid REFERENCES agents(id),
  role text NOT NULL,
  prompt_hash text NOT NULL,
  prompt_version integer,
  provider text NOT NULL,
  model text NOT NULL,
  temperature numeric,
  max_tokens integer,
  tool_schema_version text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  latency_ms integer NOT NULL,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric,
  cost_status text NOT NULL,
  success boolean NOT NULL,
  error_code text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_prompt_runs_version_check CHECK (prompt_version IS NULL OR prompt_version >= 0),
  CONSTRAINT agent_prompt_runs_hash_check CHECK (prompt_hash ~ '^(pp1:[0-9a-f]{64}|UNKNOWN)$'),
  CONSTRAINT agent_prompt_runs_provider_check CHECK (provider IN ('ollama','openai','gemini','anthropic','fallback','unknown')),
  CONSTRAINT agent_prompt_runs_latency_check CHECK (latency_ms >= 0),
  CONSTRAINT agent_prompt_runs_time_check CHECK (ended_at >= started_at),
  CONSTRAINT agent_prompt_runs_tokens_check CHECK ((prompt_tokens IS NULL OR prompt_tokens >= 0) AND (completion_tokens IS NULL OR completion_tokens >= 0) AND (total_tokens IS NULL OR total_tokens >= 0)),
  CONSTRAINT agent_prompt_runs_cost_check CHECK (cost_usd IS NULL OR cost_usd::numeric >= 0),
  CONSTRAINT agent_prompt_runs_cost_status_check CHECK (cost_status IN ('billed','free','unknown')),
  CONSTRAINT agent_prompt_runs_idempotency_check CHECK (idempotency_key ~ '^pr1:[0-9a-f]{64}$')
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agent_prompt_runs_idempotency_unique') THEN
    CREATE UNIQUE INDEX agent_prompt_runs_idempotency_unique ON agent_prompt_runs(idempotency_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agent_prompt_runs_role_version_idx') THEN
    CREATE INDEX agent_prompt_runs_role_version_idx ON agent_prompt_runs(role, prompt_version, started_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agent_prompt_runs_hash_idx') THEN
    CREATE INDEX agent_prompt_runs_hash_idx ON agent_prompt_runs(prompt_hash, started_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agent_prompt_runs_artifact_idx') THEN
    CREATE INDEX agent_prompt_runs_artifact_idx ON agent_prompt_runs(artifact_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agent_prompt_runs_started_idx') THEN
    CREATE INDEX agent_prompt_runs_started_idx ON agent_prompt_runs(started_at);
  END IF;
END $$;

-- ── 3. Immunität (optional, dokumentiert Upgrades des SQL-Drifts) ───────
-- Diese Migration ist idempotent (IF NOT EXISTS). Für Umgebungen, die
-- drizzle-kit statt psql verwenden, ist `npx drizzle-kit push` äquivalent.
