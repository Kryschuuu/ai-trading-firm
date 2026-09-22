# Datenbank-Schema & Persistenz-Verzeichnis (v1.41.0)

> **Dokumenten-Status:** Kanonisches Datenbank- und Persistenzverzeichnis  
> **Stand:** 2026-09-18 · **Code-Version:** 1.41.0  
> **Verbindliche Referenz:** `src/db/schema.ts`

Dieses Dokument spezifiziert alle 15 Drizzle-Tabellen der PostgreSQL-Datenbank sowie sämtliche dateigestützten Persistenzstrukturen des Gesamtsystems.

---

## 1. Übersicht aller Drizzle-Tabellen

| # | PostgreSQL-Tabelle | Drizzle-Export | Primärschlüssel | Fremdschlüssel-Beziehungen | Zweck |
|---|---|---|---|---|---|
| 1 | `risk_config` | `riskConfig` | `id` (UUID) | — | Informative Risikoparameter (Limits im Code) |
| 2 | `agents` | `agents` | `id` (UUID) | — | Agentenrollen, Modell-Tags, System-Prompts & Version |
| 3 | `missions` | `missions` | `id` (UUID) | — | Handelsaufträge, Scope, Marktsegmente & Budgets |
| 4 | `trade_rules` | `tradeRules` | `id` (UUID) | `missions.id`, `agents.id` | Versionierte, unveränderliche Handelsregeln |
| 5 | `rule_executions` | `ruleExecutions` | `id` (UUID) | `trade_rules.id`, `missions.id` | Feedback-Log des Micro-Executors (Latenz, Triggers, Blocks) |
| 6 | `rule_backtests` | `ruleBacktests` | `id` (UUID) | `trade_rules.id`, `missions.id` | Deterministische Backtest-Ergebnisse von Regeln |
| 7 | `positions` | `positions` | `id` (UUID) | `missions.id`, `trade_rules.id` | Offene und geschlossene Handelspositionen |
| 8 | `agent_messages` | `agentMessages` | `id` (UUID) | `agents.id`, `missions.id` | Institutionelles Gedächtnis & LLM-Traces |
| 9 | `audit_log` | `auditLog` | `id` (UUID) | `agents.id`, `missions.id` | Revisionssicheres Gesamtsystemprotokoll |
| 10 | `broker_credentials` | `brokerCredentials` | `venue` (Text) | — | Verschlüsselte API-Credentials (AES-256-GCM Envelope) |
| 11 | `venue_control_state` | `venueControlState` | `venue` (Text) | — | Persistierter Control-Plane-Zustand je Venue |
| 12 | `proposals` | `proposals` | `id` (UUID) | `missions.id`, `agents.id` | Freigabepflichtige Handelsvorschläge |
| 13 | `order_intents` | `orderIntents` | `id` (UUID) | — | Atomare Order-Reservierungen & Mehrprozess-Schutz |
| 14 | `kill_switches` | `killSwitches` | `id` (UUID) | — | Historie und Zustand des Not-Halts |
| 15 | `equity_snapshots` | `equitySnapshots` | `id` (UUID) | — | Zeitreihen für Equity-Kurve & Tages-PnL |

---

## 2. Tabellen-Spezifikationen im Detail

### 2.1 `risk_config` (Informative Risikoparameter)

Beschreibende Dokumentation der Risikogrenzen. Die *wirksamen* Schranken liegen unveränderbar im Code (`src/lib/riskGuard.ts`).

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `key` | `text` | `string` | Nein | — | Eindeutiger Parameterschlüssel (z. B. `maxRiskPerTrade`) |
| `value` | `numeric` | `string` | Nein | — | Numerischer Wert als Decimal-String |
| `description` | `text` | `string` | Ja | `null` | Fachliche Erklärung |
| `updated_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Letzte Aktualisierung |

- **Indizes / Constraints:** `UNIQUE (key)`

---

### 2.2 `agents` (Agenten-Konfiguration & Prompt-Versionierung)

Verwaltet die Agenten der Handelsfirma, deren Prompts und Optimistic-Lock-Versionen.

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `name` | `text` | `string` | Nein | — | Eindeutiger Agenten-Name |
| `role` | `text` | `string` | Nein | — | Rolle (`CEO`, `RESEARCH`, `TECHNICAL_ANALYST`, etc.) |
| `model` | `text` | `string` | Nein | — | Modelltag (z. B. `qwen2.5:7b-instruct-q4_K_M`) |
| `status` | `text` | `string` | Nein | `'IDLE'` | Zustand (`IDLE`, `RUNNING`, `BLOCKED`, `STOPPED`) |
| `system_prompt` | `text` | `string` | Nein | — | Vollständiger System-Prompt |
| `version` | `integer` | `number` | Nein | `1` | Optimistic-Lock-Version (W2: Inkrement bei jedem Update) |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Erstellungszeitpunkt |
| `updated_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Aktualisierungszeitpunkt |

- **Indizes / Constraints:** `UNIQUE (name)`

---

### 2.3 `missions` (Handelsaufträge & Mandate)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `title` | `text` | `string` | Nein | — | Titel der Mission |
| `objective` | `text` | `string` | Nein | — | Freitext-Zielsetzung |
| `symbol` | `text` | `string` | Ja | `null` | Einzelsymbol bei `scope = 'SINGLE_SYMBOL'` |
| `scope` | `text` | `string` | Nein | `'SINGLE_SYMBOL'` | `SINGLE_SYMBOL` oder `SCAN_UNIVERSE` |
| `segment` | `text` | `string` | Ja | `null` | Marktsegment bei Universe-Scan (z. B. `ALL`, `INDICES`) |
| `template_id` | `text` | `string` | Ja | `null` | Vorlagen-Slug (`src/lib/missionTemplates.ts`) |
| `risk_budget` | `numeric` | `string` | Nein | `'0.02'` | Maximales Risikobudget (z. B. 0.02 = 2 %) |
| `max_position_pct` | `numeric` | `string` | Nein | `'0.25'` | Maximale Positionsgröße bezogen auf Equity |
| `status` | `text` | `string` | Nein | `'PENDING'` | `PENDING`, `ACTIVE`, `COMPLETED`, `KILLED` |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Erstellungszeitpunkt |
| `updated_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Aktualisierungszeitpunkt |

---

### 2.4 `trade_rules` (Handelsregeln & Versionierung)

Regelwerk des Makro-Zyklus. Jede Zeile ist unveränderlich (Immutable Version).

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `rule_key` | `uuid` | `string` | Nein | — | Logische Regel-Identität (v1 → v2 → …) |
| `version` | `integer` | `number` | Nein | `1` | Fortlaufende Versionsnummer |
| `status` | `text` | `string` | Nein | `'DRAFT'` | `DRAFT`, `ACTIVE`, `SUPERSEDED`, `PAUSED`, `ARCHIVED`, `REJECTED` |
| `name` | `text` | `string` | Nein | — | Name der Regel |
| `symbol` | `text` | `string` | Nein | — | Ziel-Symbol (z. B. `BTCUSDT`) |
| `mission_id` | `uuid` | `string` | Ja | `null` | FK → `missions.id` |
| `condition` | `jsonb` | `RuleCondition` | Nein | — | Validierte Bedingungs-DSL (`src/lib/ruleEngine.ts`) |
| `action` | `jsonb` | `RuleAction` | Nein | — | Geklemmte Aktionsparameter (`side`, `sl`, `tp`, `budget`) |
| `window` | `jsonb` | `RuleWindow` | Nein | — | Zeitfenster, Cooldown & max. Ausführungen |
| `signature` | `text` | `string` | Nein | — | FNV-1a Hash über Symbol, Condition und Action |
| `rationale` | `text` | `string` | Ja | `null` | Begründung des LLM / Erstellers |
| `source_role` | `text` | `string` | Nein | `'MANUAL'` | `CEO`, `RESEARCH`, `MANUAL` |
| `source_agent_id`| `uuid` | `string` | Ja | `null` | FK → `agents.id` |
| `source_mode` | `text` | `string` | Nein | `'SIGMA'` | `SIGMA` (LLM) oder `FALLBACK` (deterministisch) |
| `previous_version_id` | `uuid` | `string` | Ja | `null` | Vorgängerversion (ohne DB-FK wegen Zirkularität) |
| `superseded_by_id` | `uuid` | `string` | Ja | `null` | Nachfolgeversion |
| `activated_at` | `timestamp with time zone` | `Date` | Ja | `null` | Aktivierungszeitpunkt |
| `deactivated_at` | `timestamp with time zone` | `Date` | Ja | `null` | Deaktivierungszeitpunkt |
| `risk_score` | `numeric` | `string` | Nein | `'0.5'` | Risikobewertung (0..1) |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Erstellungszeitpunkt |
| `updated_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Aktualisierungszeitpunkt |

- **Indizes / Constraints:**
  - `trade_rules_active_unique`: `UNIQUE (rule_key) WHERE status = 'ACTIVE'`
  - `trade_rules_active_symbol_unique`: `UNIQUE ("symbol", COALESCE(mission_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'ACTIVE'`

---

### 2.5 `rule_executions` (Ausführungs-Feedback des Micro-Executors)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `rule_id` | `uuid` | `string` | Nein | — | FK → `trade_rules.id` |
| `mission_id` | `uuid` | `string` | Ja | `null` | FK → `missions.id` |
| `symbol` | `text` | `string` | Nein | — | Gehandeltes Symbol |
| `status` | `text` | `string` | Nein | — | `TRIGGERED`, `BLOCKED`, `ERROR`, `EXPIRED` |
| `trigger_price` | `numeric` | `string` | Ja | `null` | Preis zum Trigger-Zeitpunkt |
| `trigger_volume`| `numeric` | `string` | Ja | `null` | Volumen zum Trigger-Zeitpunkt |
| `snapshot` | `jsonb` | `RuleSnapshot` | Ja | `null` | Indikatoren-Snapshot zum Trigger-Zeitpunkt |
| `evaluated` | `jsonb` | `Record<string, unknown>` | Ja | `null` | Tatsächliche Werte der Bedingungen |
| `fill` | `jsonb` | `Fill` | Ja | `null` | Fill-Details oder Block-Grund |
| `order_id` | `text` | `string` | Ja | `null` | Broker-Order-ID |
| `latency_micros`| `integer` | `number` | Ja | `null` | Reine Evaluierungszeit in Mikrosekunden |
| `reason` | `text` | `string` | Ja | `null` | Textuelle Begründung / Fehlertext |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Zeitstempel |

- **Indizes / Constraints:**
  - `rule_executions_rule_idx`: `INDEX (rule_id, created_at)`

---

### 2.6 `rule_backtests` (Deterministische Backtest-Ergebnisse)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `rule_id` | `uuid` | `string` | Nein | — | FK → `trade_rules.id` |
| `mission_id` | `uuid` | `string` | Ja | `null` | FK → `missions.id` |
| `symbol` | `text` | `string` | Nein | — | Getestetes Symbol |
| `timeframe` | `text` | `string` | Nein | — | Timeframe (z. B. `1h`) |
| `from` | `timestamp with time zone` | `Date` | Nein | — | Startzeitpunkt des Backtests |
| `to` | `timestamp with time zone` | `Date` | Nein | — | Endzeitpunkt des Backtests |
| `trades` | `integer` | `number` | Nein | `0` | Anzahl simulierter Trades |
| `wins` | `integer` | `number` | Nein | `0` | Anzahl gewinnender Trades |
| `pnl` | `numeric` | `string` | Nein | `'0'` | Gesamter PnL in Kontowährung |
| `profit_factor` | `numeric` | `string` | Ja | `null` | Profit Factor |
| `max_drawdown_pct`| `numeric` | `string` | Ja | `null` | Maximaler Drawdown in Prozent |
| `detail` | `jsonb` | `Record<string, unknown>` | Nein | — | Vollständige Turn-Liste und Kennzahlen |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Zeitstempel |

- **Indizes / Constraints:**
  - `rule_backtests_rule_idx`: `INDEX (rule_id, created_at)`

---

### 2.7 `positions` (Positionen & PnL-Tracking)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `symbol` | `text` | `string` | Nein | — | Symbol |
| `side` | `text` | `string` | Nein | — | `LONG` oder `SHORT` |
| `qty` | `numeric` | `string` | Nein | — | Kontraktanzahl / Positionsgröße |
| `entry_price` | `numeric` | `string` | Nein | — | Ausführungspreis beim Einstieg (> 0) |
| `current_price` | `numeric` | `string` | Ja | `null` | Zuletzt bekannter Marktpreis |
| `stop_loss` | `numeric` | `string` | Ja | `null` | Stop-Loss-Preis |
| `take_profit` | `numeric` | `string` | Ja | `null` | Take-Profit-Preis |
| `exit_price` | `numeric` | `string` | Ja | `null` | Ausführungspreis beim Ausstieg |
| `realized_pnl` | `numeric` | `string` | Ja | `null` | Realisierter Gewinn/Verlust |
| `exit_reason` | `text` | `string` | Ja | `null` | `STOP_LOSS`, `TAKE_PROFIT`, `TRAILING_STOP`, `TIME_STOP`, `SIGNAL_DECAY`, `MANUAL_FLATTEN`, `AGENT_CLOSE`, `RULE_EXECUTION` |
| `entry_signal` | `jsonb` | `object` | Ja | `null` | Unveränderlicher Entry-Signal-Snapshot `sig1` (RMA-P5-05). NULL = nicht erfasst. |
| `entry_signal_hash` | `text` | `string` | Ja | `null` | Hash des Entry-Snapshots. |
| `signal_decay_streak` | `integer` | `number` | Nein | `0` | Bestätigungszähler, überlebt Neustart. |
| `signal_decay_last_key` | `text` | `string` | Ja | `null` | Letzte gezählte Beobachtung. |
| `signal_decay_policy_version` | `text` | `string` | Ja | `null` | Policyversion der laufenden Zählung. |
| `strategy_class` | `text` | `string` | Ja | `null` | `mean-reversion`, `trend`, `breakout`, `unclassified`. |
| `broker` | `text` | `string` | Nein | — | Venue-ID (`PAPER`, `BITUNIX`, etc.) |
| `status` | `text` | `string` | Nein | `'OPEN'` | `OPEN` oder `CLOSED` |
| `mission_id` | `uuid` | `string` | Ja | `null` | FK → `missions.id` |
| `rule_id` | `uuid` | `string` | Ja | `null` | FK → `trade_rules.id` |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Einstiegszeitpunkt |
| `updated_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Letzte Aktualisierung |

- **Indizes / Constraints:**
  - `positions_open_idx`: `INDEX ("symbol") WHERE status = 'OPEN'` (RESTORE-01 / v1.36.37)

---

### 2.8 `agent_messages` (Institutionelles Gedächtnis)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `agent_id` | `uuid` | `string` | Ja | `null` | FK → `agents.id` |
| `mission_id` | `uuid` | `string` | Ja | `null` | FK → `missions.id` |
| `type` | `text` | `string` | Nein | — | `INSTRUCTION`, `REQUEST`, `APPROVAL`, `REJECTION`, `REPORT`, `ANALYSIS` |
| `content` | `text` | `string` | Nein | — | Nachrichtentext / Zusammenfassung |
| `meta` | `jsonb` | `Record<string, unknown>` | Ja | `null` | Strukturierte Daten (View, Confidence, Prompt, Trace, Latency, Kosten) |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Zeitstempel |

---

### 2.9 `audit_log` (Revisionssicheres Systemprotokoll)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `event` | `text` | `string` | Nein | — | Ereignistyp (`BROKER_FACTORY`, `ORDER_PLACED`, `CYCLE_STARTED`, `LIVE_GATE`, etc.) |
| `agent_id` | `uuid` | `string` | Ja | `null` | FK → `agents.id` |
| `mission_id` | `uuid` | `string` | Ja | `null` | FK → `missions.id` |
| `level` | `text` | `string` | Nein | `'INFO'` | `INFO`, `WARN`, `CRITICAL` |
| `detail` | `jsonb` | `Record<string, unknown>` | Ja | `null` | Maschinenlesbare Payload-Details |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Revisionszeitpunkt |

---

### 2.10 `broker_credentials` (Verschlüsselte Venue-Secrets)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `venue` | `text` | `string` | Nein | — | Primärschlüssel (z. B. `BITUNIX`) |
| `envelope` | `text` | `string` | Nein | — | AES-256-GCM Envelope (IV, Tag, Ciphertext; AAD = venue) |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Erstellungszeitpunkt |
| `updated_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Aktualisierungszeitpunkt |

---

### 2.11 `venue_control_state` (Control-Plane Status)

Persistierter Zustand der Control-Plane-Ebenen je Venue (C4 / v1.36.16).

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `venue` | `text` | `string` | Nein | — | Primärschlüssel (`BITUNIX`, `ALPACA`, etc.) |
| `configured` | `boolean` | `boolean` | Nein | `false` | Credentials hinterlegt? |
| `connected` | `boolean` | `boolean` | Nein | `false` | Verbindung erfolgreich getestet? |
| `permissions` | `jsonb` | `string[]` | Nein | `'[]'` | Verifizierte Rechte (`READ`, `TRADE`) |
| `live_enabled` | `boolean` | `boolean` | Nein | `false` | Momentaufnahme der Live-Freigabe |
| `last_probe` | `timestamp with time zone` | `Date` | Ja | `null` | Zeitpunkt des letzten Health-Checks |
| `connection_state` | `text` | `string` | Nein | `'off'` | `off`, `probing`, `ready`, `error` |
| `discovery_state` | `text` | `string` | Nein | `'off'` | `off`, `syncing`, `ready`, `error` |
| `discovery_count` | `integer` | `number` | Nein | `0` | Anzahl gefundener Instrumente |
| `discovery_last_sync` | `timestamp with time zone` | `Date` | Ja | `null` | Letzter Discovery-Sync |
| `last_error` | `text` | `string` | Ja | `null` | Redigierter Fehlercode |
| `layers` | `jsonb` | `Record<string, unknown>` | Ja | `null` | Vollständiger 6-Ebenen-Snapshot |
| `updated_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Aktualisierungszeitpunkt |

---

### 2.12 `proposals` (Handelsvorschläge)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `mission_id` | `uuid` | `string` | Ja | `null` | FK → `missions.id` |
| `agent_id` | `uuid` | `string` | Ja | `null` | FK → `agents.id` |
| `action` | `text` | `string` | Nein | — | `OPEN`, `CLOSE`, `ADJUST` |
| `detail` | `jsonb` | `Record<string, unknown>` | Nein | — | Vorgeschlagene Parameter (`symbol`, `side`, `qty`, `sl`, `tp`) |
| `risk_score` | `numeric` | `string` | Nein | `'0'` | Berechneter Risk-Score |
| `status` | `text` | `string` | Nein | `'PENDING'` | `PENDING`, `APPROVED`, `REJECTED`, `AUTO_REJECTED` |
| `reason` | `text` | `string` | Ja | `null` | Begründung für Annahme oder Ablehnung |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Erstellungszeitpunkt |
| `reviewed_at` | `timestamp with time zone` | `Date` | Ja | `null` | Prüfzeitpunkt |

---

### 2.13 `order_intents` (Atomare Order-Reservierungen)

Sichert die Mehrprozess-Serialisierung und verhindert Doppel-Orders (H2 / v1.36.19).

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `account` | `text` | `string` | Nein | `'PAPER'` | Kontokennung |
| `symbol` | `text` | `string` | Nein | — | Symbol |
| `side` | `text` | `string` | Nein | — | `LONG` oder `SHORT` |
| `qty` | `numeric` | `string` | Nein | — | Kontraktanzahl |
| `status` | `text` | `string` | Nein | `'RESERVED'` | `RESERVED`, `FILLED`, `REJECTED`, `CANCELED` |
| `reason` | `text` | `string` | Ja | `null` | Ablehnungs- oder Fehlergrund |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Reservierungszeitpunkt |

- **Indizes / Constraints:**
  - `order_intents_reserved_symbol_unique`: `UNIQUE ("symbol") WHERE status = 'RESERVED'`
  - `order_intents_account_idx`: `INDEX (account, created_at)`

---

### 2.14 `kill_switches` (Not-Halt-Historie)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `reason` | `text` | `string` | Nein | `'MANUAL'` | Auslöser (`MANUAL`, `MAX_DRAWDOWN`, `DAILY_LOSS`, etc.) |
| `triggered_by` | `text` | `string` | Nein | — | Auslösender Actor / Prozess |
| `armed` | `boolean` | `boolean` | Nein | `true` | `true` = Not-Halt scharf (Handel blockiert) |
| `created_at` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Zeitstempel |

---

### 2.15 `equity_snapshots` (Equity- & Performance-Kurve)

| Spalte | Typ (PG) | Typ (TS) | Nullable | Default | Beschreibung |
|---|---|---|---|---|---|
| `id` | `uuid` | `string` | Nein | `defaultRandom()` | Primärschlüssel |
| `ts` | `timestamp with time zone` | `Date` | Nein | `defaultNow()` | Snapshot-Zeitstempel |
| `equity` | `numeric` | `string` | Nein | — | Gesamtvermögen in Kontowährung |
| `cash` | `numeric` | `string` | Nein | — | Freies Barvermögen |
| `open_positions`| `integer` | `number` | Nein | `0` | Anzahl offener Positionen |
| `realized_pnl_today`| `numeric` | `string` | Nein | `'0'` | Realisierter Tages-PnL (Berliner Tag) |
| `trigger` | `text` | `string` | Nein | `'TICK'` | `TICK`, `TRADE`, `CLOSE`, `FLATTEN`, `BOOT` |

---

## 3. Dateibasierte Persistenzstrukturen (Außerhalb der DB)

| Ablagepfad | Format | Zugriffsmodus | Schema / Struktur | Retention & Lifecycle |
|---|---|---|---|---|
| `data/universe/instruments.ndjson` | NDJSON | Append/Upsert atomar (`0600`) | `MarketInstrument` (ID, Symbol, Base, Quote, Fees, Spread, Vol24h, Status) | Unbegrenzt; aktualisiert durch `market:sync` |
| `data/history/candles.ndjson` | NDJSON | Append/Kompaktierung atomar (`0600`) | Schema v2: `{ v: 2, instrumentId, venue, feed, timeframe, ts, o, h, l, c, v, fetchedAt }` | Max. 5.000 Kerzen je `(instrumentId, timeframe)` |
| `artifacts/<YYYY-MM-DD>/daily/*` | JSON | Atomar (`.tmp` + rename) | `01-market-scanner.json` bis `08-backtest-verification.json` + `daily-summary.json` | 30 Tage (`CYCLE_RETENTION_DAYS`) |
| `artifacts/<YYYY-Www>/weekly/*` | JSON | Atomar (`.tmp` + rename) | `weekly-review.json`, `universe-classification.json`, `weekly-summary.json` | 12 Wochen (`CYCLE_RETENTION_WEEKS`) |
| `artifacts/index.json` | JSON | Atomar | Index-Manifest aller Daily- und Weekly-Läufe | Synchronisiert beim Pruning |
| `data/live-gate/venue-{VENUE}.json` | JSON | Atomar (`0600`) | Live-Gate Machine-State, Cooldowns, 4-Augen, Kettenkopf | Unbegrenzt; Zustand übersteht Neustarts |
| `data/live-gate/audit-log.ndjson` | NDJSON | Append-only (`0600`) | SHA-256 kryptografische Hash-Kette aller Gate-Übergänge | Unbegrenzt; manipulationssicher |
| `data/live-gate/kill-switch.json` | JSON | Failsafe (`0600`) | Persistente Kill-Sperre (NDJSON) | Gültig bis explizites `clear` |
| `data/live-gate/security-suite.json`| JSON | CI-Artefakt | CI-Security-Suite-Stamp (`passed`, `runId`, `timestamp`) | Max. 7 Tage (`LIVE_GATE_SUITE_MAX_AGE_MS`) |
| `data/portfolio/audit-log.ndjson` | NDJSON | Append-only | Audit-Events des Portfolio-Optimizers & Risk-Guards | Optional via `PORTFOLIO_AUDIT_DIR` |
| `data/routing/audit-log.ndjson` | NDJSON | Append-only | Audit-Events des Model-Routers & Eskalations-Entscheidungen | Unbegrenzt |
| `data/market-data-errors.json` | JSON | Atomic | Klassifiziertes Fehlermanifest des Market-Data-Syncs | Überschrieben bei jedem Sync-Lauf |
