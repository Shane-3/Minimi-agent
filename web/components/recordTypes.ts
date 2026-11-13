import type { RecordType } from "../../shared/types.ts";

/** How each record type is named in the interface. */
export const TYPE_LABELS: { [type in RecordType]: string } = { meeting: "Meeting", chat: "Chat", note: "Note" };
