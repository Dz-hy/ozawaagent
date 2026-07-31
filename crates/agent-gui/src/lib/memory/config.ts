// Every tunable number and locale-sensitive word list in the memory system
// lives here. No other memory module may declare a magic number.

// --- Memory Index injection --------------------------------------------------

export const INDEX_MAX_PROMPT_CHARS = 16_000;
export const INDEX_MAX_ENTRIES_PER_BUCKET = 30;

// --- Store limits (mirrors Rust constants; Rust enforces) --------------------

export const MEMORY_BODY_LIMIT_BYTES = 8 * 1024;
export const MEMORY_SCOPE_ENTRY_LIMIT = 500;
export const MEMORY_DESCRIPTION_CHAR_LIMIT = 120;

// --- Organizer ---------------------------------------------------------------

/** Structural cluster size when the library is small enough to skip the
 *  LLM topic pass. */
export const ORGANIZER_STRUCTURAL_CLUSTER_SIZE = 8;
/** Max entries per LLM topic cluster. */
export const ORGANIZER_TOPIC_CLUSTER_SIZE = 12;
/** Per-entry body excerpt shown inside a cluster planning prompt. */
export const ORGANIZER_BODY_EXCERPT_CHARS = 3_000;
/** Per-entry excerpt in the global inventory / meta-cluster prompt. */
export const ORGANIZER_META_BODY_EXCERPT_CHARS = 600;
export const ORGANIZER_GLOBAL_INVENTORY_CHARS = 8_000;
/** Cap of raw model output preserved per cluster in the run report. */
export const ORGANIZER_RAW_PROTOCOL_CHARS = 4_000;
/** Never sleep longer than this between scheduler wake checks. */
export const ORGANIZER_MAX_WAKE_DELAY_MS = 60 * 60_000;

/** Quota ladder thresholds on remaining headroom (entries left in scope). */
export const QUOTA_LADDER_THRESHOLDS = {
  /** headroom > notice ⇒ normal */
  notice: 100,
  degraded: 50,
  critical: 20,
  exhausted: 5,
} as const;

// --- Settings panel ------------------------------------------------------------

/** Poll cadence for organize-run status — applied ONLY while a run is
 *  pending/running; idle panels never poll. */
export const PANEL_RUN_POLL_INTERVAL_MS = 2_000;
