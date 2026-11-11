// The only file that touches SQLite. Everything else goes through the Store.
import Database from "better-sqlite3";
import type { MemoryRecord, RecordSource, RecordSummary, RecordType, Segment } from "../../shared/types.ts";

/** A record ready to store: validated and normalised by the importer. */
export interface NewRecord {
  type: RecordType;
  title: string;
  startedAt: string;
  tz: string | null;
  participants: string[];
  source: RecordSource;
  contentHash: string;
  segments: NewSegment[];
}

export interface NewSegment {
  speaker: string | null;
  text: string;
  ts: string | null;
}

export interface InsertResult {
  inserted: number;
  /** Records whose content hash was already stored, or repeated in the same batch. */
  skipped: number;
}

export interface SegmentHit {
  segmentId: number;
  recordId: string;
  /** FTS5 bm25 score: lower is a better match. */
  score: number;
}

/** Any database failure. Callers show a plain message and carry on without saving. */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('meeting', 'chat', 'note')),
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    tz TEXT,
    participants TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('import', 'live')),
    content_hash TEXT NOT NULL UNIQUE
  );

  CREATE INDEX IF NOT EXISTS records_started_at ON records (started_at);

  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL,
    ts TEXT
  );

  CREATE INDEX IF NOT EXISTS segments_record ON segments (record_id, seq);

  -- One row per segment, rowid = segments.id. The title is repeated on each
  -- row so a search for a meeting's name finds its segments. Porter stemming
  -- lets "renewing" match "renewal".
  CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5 (
    text,
    title,
    record_id UNINDEXED,
    tokenize = 'porter unicode61'
  );
`;

interface RecordRow {
  id: string;
  type: RecordType;
  title: string;
  started_at: string;
  tz: string | null;
  participants: string;
  source: RecordSource;
}

interface SegmentRow {
  id: number;
  seq: number;
  speaker: string | null;
  text: string;
  ts: string | null;
}

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = guard("open the database", () => {
      const db = new Database(path);
      // WAL keeps reads fast while a turn is being saved.
      db.pragma("journal_mode = WAL");
      // Off by default in SQLite; needed for ON DELETE CASCADE.
      db.pragma("foreign_keys = ON");
      db.exec(SCHEMA);
      return db;
    });
  }

  /**
   * Stores records in one transaction: either all new ones are saved or none.
   * A record whose content hash is already stored is skipped, not an error.
   */
  insertRecords(records: NewRecord[]): InsertResult {
    return guard("save records", () => {
      const insertRecord = this.db.prepare(`
        INSERT INTO records (id, type, title, started_at, tz, participants, source, content_hash)
        VALUES (@id, @type, @title, @startedAt, @tz, @participants, @source, @contentHash)
        ON CONFLICT (content_hash) DO NOTHING
      `);
      const insertSegment = this.db.prepare(`
        INSERT INTO segments (record_id, seq, speaker, text, ts) VALUES (?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare(`
        INSERT INTO segments_fts (rowid, text, title, record_id) VALUES (?, ?, ?, ?)
      `);

      const run = this.db.transaction((batch: NewRecord[]): InsertResult => {
        let inserted = 0;
        for (const record of batch) {
          const id = crypto.randomUUID();
          const result = insertRecord.run({
            id,
            type: record.type,
            title: record.title,
            startedAt: record.startedAt,
            tz: record.tz,
            participants: JSON.stringify(record.participants),
            source: record.source,
            contentHash: record.contentHash,
          });
          // No change means the hash was already there: a duplicate.
          if (result.changes === 0) continue;
          inserted += 1;
          record.segments.forEach((segment, seq) => {
            const segmentResult = insertSegment.run(id, seq, segment.speaker, segment.text, segment.ts);
            insertFts.run(segmentResult.lastInsertRowid, segment.text, record.title, id);
          });
        }
        return { inserted, skipped: batch.length - inserted };
      });

      return run(records);
    });
  }

  /** Every record, newest first. */
  listRecords(): RecordSummary[] {
    return guard("read records", () => {
      const rows = this.db
        .prepare(`SELECT id, type, title, started_at, tz, participants, source FROM records ORDER BY started_at DESC`)
        .all() as RecordRow[];
      return rows.map(toSummary);
    });
  }

  getRecord(id: string): MemoryRecord | null {
    return guard("read a record", () => {
      const row = this.db
        .prepare(`SELECT id, type, title, started_at, tz, participants, source FROM records WHERE id = ?`)
        .get(id) as RecordRow | undefined;
      if (row === undefined) return null;
      const segments = this.db
        .prepare(`SELECT id, seq, speaker, text, ts FROM segments WHERE record_id = ? ORDER BY seq`)
        .all(id) as SegmentRow[];
      return { ...toSummary(row), tz: row.tz, source: row.source, segments: segments.map(toSegment) };
    });
  }

  /** Returns false when no record had that id. */
  deleteRecord(id: string): boolean {
    return guard("remove a record", () => {
      const run = this.db.transaction((recordId: string) => {
        // The FTS table has no foreign key, so its rows are removed by hand.
        this.db.prepare(`DELETE FROM segments_fts WHERE record_id = ?`).run(recordId);
        return this.db.prepare(`DELETE FROM records WHERE id = ?`).run(recordId).changes > 0;
      });
      return run(id);
    });
  }

  /** Removes every record and chat. */
  clearAll(): void {
    guard("clear memory", () => {
      this.db.transaction(() => {
        this.db.exec(`DELETE FROM segments_fts; DELETE FROM segments; DELETE FROM records;`);
      })();
    });
  }

  /**
   * Full-text search over segment text and record titles. `match` is an FTS5
   * query; building a safe one from a user's message is the caller's job.
   */
  searchSegments(match: string, limit: number): SegmentHit[] {
    return guard("search records", () => {
      return this.db
        .prepare(`
          SELECT rowid AS segmentId, record_id AS recordId, bm25(segments_fts) AS score
          FROM segments_fts
          WHERE segments_fts MATCH ?
          ORDER BY score
          LIMIT ?
        `)
        .all(match, limit) as SegmentHit[];
    });
  }

  close(): void {
    this.db.close();
  }
}

function toSummary(row: RecordRow): RecordSummary {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    startedAt: row.started_at,
    participants: JSON.parse(row.participants) as string[],
  };
}

function toSegment(row: SegmentRow): Segment {
  return { id: row.id, seq: row.seq, speaker: row.speaker, text: row.text, ts: row.ts };
}

// Turns any SQLite failure into a StoreError that says what was being done,
// so callers can catch one type.
function guard<T>(action: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(`Could not ${action}.`, { cause: error });
  }
}
