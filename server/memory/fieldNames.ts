// People bring history exported from many tools, with their own field names.
// Before an import file is checked, the common alternatives are renamed to
// the ones the importer reads (ARCHITECTURE.md §3), so { date, messages: [{
// from, body }] } loads like { timestamp, turns: [{ speaker, text }] }. A name
// the file already uses is never overwritten, so files in the documented
// format pass through unchanged, and errors still name the documented fields.

type Json = { [key: string]: unknown };

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const TIMESTAMP = ["timestamp", "date", "datetime", "time", "created_at", "createdAt", "created", "create_time", "created_time", "sent_at", "sentAt", "start", "started_at", "startedAt", "start_time", "ts"];
const SPEAKER = ["speaker", "from", "author", "sender", "name", "user", "who"];
const TEXT = ["text", "message", "body", "msg"];
const LIST_KEYS = ["records", "conversations", "messages", "items", "entries", "data", "logs"];

/** Kinds of record as other tools name them, mapped to "meeting", "chat" or "note". */
const TYPE_NAMES: { [name: string]: "meeting" | "chat" | "note" } = {
  meeting: "meeting", call: "meeting", transcript: "meeting", standup: "meeting", interview: "meeting", "video call": "meeting",
  chat: "chat", message: "chat", messages: "chat", conversation: "chat", thread: "chat", email: "chat", "e-mail": "chat", mail: "chat",
  whatsapp: "chat", slack: "chat", sms: "chat", telegram: "chat", teams: "chat", dm: "chat",
  note: "note", notes: "note", doc: "note", document: "note", memo: "note", journal: "note",
};

/** The first of `names` the object has, as [name, value]. */
function first(item: Json, names: string[]): [string, unknown] | undefined {
  const name = names.find((candidate) => item[candidate] !== undefined);
  return name === undefined ? undefined : [name, item[name]];
}

/** Sets `to` from the first alias present, when `to` itself is absent. */
function rename(item: Json, to: string, names: string[]): void {
  if (item[to] !== undefined) return;
  const found = first(item, names);
  if (found !== undefined) {
    item[to] = found[1];
    delete item[found[0]];
  }
}

/** Unix time in seconds or milliseconds, as many exports write it, becomes ISO 8601 (UTC). */
function timestampOf(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

function normaliseTurn(value: unknown): unknown {
  if (!isObject(value)) return value;
  const turn = { ...value };
  rename(turn, "speaker", SPEAKER.slice(1).concat("role"));
  rename(turn, "text", [...TEXT.slice(1), "content"]);
  rename(turn, "timestamp", TIMESTAMP.slice(1));
  if (turn.timestamp !== undefined) turn.timestamp = timestampOf(turn.timestamp);
  return turn;
}

/** A single chat message ({ role, content, timestamp }), as chat exports list them. */
function looksLikeMessage(item: Json): boolean {
  const hasWho = first(item, ["role", ...SPEAKER]) !== undefined;
  const hasWords = first(item, ["content", ...TEXT]) !== undefined;
  return hasWho && hasWords && first(item, ["type", "turns", "messages", "transcript", "title", "subject"]) === undefined;
}

function normaliseMessage(item: Json): Json {
  const message = { ...item };
  rename(message, "role", SPEAKER);
  rename(message, "content", TEXT);
  rename(message, "timestamp", TIMESTAMP.slice(1));
  if (message.timestamp !== undefined) message.timestamp = timestampOf(message.timestamp);
  return message;
}

function normaliseRecord(item: Json): Json {
  const record = { ...item };
  rename(record, "timestamp", TIMESTAMP.slice(1));
  if (record.timestamp !== undefined) record.timestamp = timestampOf(record.timestamp);
  rename(record, "title", ["subject", "topic", "name"]);
  rename(record, "participants", ["attendees", "members", "people"]);
  rename(record, "type", ["kind", "category", "channel", "platform", "source"]);

  if (record.turns === undefined) {
    const turns = first(record, ["messages", "utterances", "entries", "conversation", "transcript"]);
    if (turns !== undefined && Array.isArray(turns[1])) {
      record.turns = turns[1];
      delete record[turns[0]];
    }
  }
  // One message with a sender, such as an email { from, subject, body }: one turn, so the sender is kept.
  if (record.turns === undefined && record.content === undefined) {
    const who = first(record, SPEAKER);
    const words = first(record, TEXT);
    if (who !== undefined && words !== undefined && typeof words[1] === "string") {
      record.turns = [{ speaker: who[1], text: words[1], ...(record.timestamp === undefined ? {} : { timestamp: record.timestamp }) }];
      delete record[who[0]];
      delete record[words[0]];
    }
  }
  if (record.turns === undefined) rename(record, "content", ["transcript", "text", "body", "notes"]);

  // Anything else with a date (an article, a task, a bookmark): each of its
  // other fields becomes a line of the record, so nothing in the file is
  // lost. As separate turns, so "summary: ..." is not read as a speaker.
  let fromFields = false;
  // Without a title, the first field's value names the record ("Draft the pricing page copy").
  let fieldTitle = "";
  if (record.turns === undefined && record.content === undefined) {
    const fields = Object.entries(record)
      .filter(([key]) => !RECORD_FIELDS.has(key))
      .flatMap(([key, value]) => {
        const text = textOf(value);
        return text === "" ? [] : [{ key, text }];
      });
    if (fields.length > 0) {
      // A lone field of real text needs no label; otherwise each keeps its own
      // ("due: 2026-11-14", "location: Koramangala").
      const unlabelled = fields.length === 1 && fields[0]!.text.split(/\s+/).length >= 4;
      record.turns = fields.map(({ key, text }) => ({ text: unlabelled ? text : `${key}: ${text}` }));
      fieldTitle = shorten(fields[0]!.text);
      fromFields = true;
    }
  }
  if (Array.isArray(record.turns)) record.turns = record.turns.map(normaliseTurn);

  if (typeof record.type === "string") {
    const lower = record.type.trim().toLowerCase();
    // A kind of note with its own name (journal, memo, document) keeps that
    // name in its title, as unknown kinds do, so it can be asked for by name.
    const known = TYPE_NAMES[lower] === "note" && lower !== "note" && lower !== "notes" ? undefined : TYPE_NAMES[lower];
    if (known !== undefined) {
      // A known kind under another name ("email", "call") becomes one of the three.
      record.type = known;
    } else if (record.type.trim() !== "") {
      // Any other kind is kept as a note, with the kind in its title, so
      // "which articles did I read?" still finds it.
      const kind = record.type.trim().charAt(0).toUpperCase() + record.type.trim().slice(1);
      const title = typeof record.title === "string" && record.title.trim() !== "" ? record.title.trim() : fieldTitle;
      record.title = title === "" ? kind : `${kind}: ${title}`;
      record.type = "note";
    }
  }
  if (record.title === undefined && fieldTitle !== "") record.title = fieldTitle;
  // No kind at all: a conversation if it has turns of its own, otherwise a note.
  if (record.type === undefined) {
    record.type = record.turns !== undefined && !fromFields ? "chat" : record.content !== undefined || fromFields ? "note" : undefined;
  }
  return record;
}

/** Fields the importer reads itself; the rest of a record can become its text. */
const RECORD_FIELDS = new Set(["timestamp", "type", "title", "participants", "id", "turns", "content"]);

/** The first words of a text, for a title. */
function shorten(text: string): string {
  const words = text.split(/\s+/);
  return words.length <= 8 ? text : `${words.slice(0, 8).join(" ")}...`;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date-only value ("2026-12-04", a due date) written with its weekday, "Fri
 * 4 Dec 2026", worked out here so the model never has to. A calendar day,
 * so no timezone applies.
 */
function dayText(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCMonth() !== Number(match[2]) - 1) return value;
  return `${WEEKDAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** A field's value as one line of text. */
function textOf(value: unknown): string {
  if (typeof value === "string") return dayText(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) return value.join(", ");
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * The file with alternative field names renamed. Shapes it does not
 * recognise are returned as they are, for the importer to report.
 */
export function normaliseFieldNames(value: unknown): unknown {
  let items: unknown = value;
  if (isObject(value)) {
    const list = first(value, LIST_KEYS);
    const arrays = Object.values(value).filter(Array.isArray);
    if (list !== undefined && Array.isArray(list[1])) items = list[1];
    // An object holding a single list under another name ("journal", "reading").
    else if (arrays.length === 1) items = arrays[0];
    // A single record on its own.
    else if (first(value, TIMESTAMP) !== undefined) items = [value];
    else return value;
  }
  if (!Array.isArray(items)) return value;
  const list = items.map((item) => {
    if (!isObject(item)) return item;
    return looksLikeMessage(item) ? normaliseMessage(item) : normaliseRecord(item);
  });
  return { records: list };
}
