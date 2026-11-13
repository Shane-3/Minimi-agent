// The records list and the import in progress.
import type { ImportResult, RecordSummary } from "../../shared/types.ts";

export interface RecordsState {
  phase: "loading" | "ready" | "error";
  records: RecordSummary[];
  /** Why the list couldn't be read (phase "error"). */
  loadError: string | null;
  /** Ids being removed now. */
  removing: string[];
  /** A remove or clear that failed, shown above the list. */
  actionError: string | null;
  import: ImportState;
}

export type ImportState =
  | { phase: "idle" }
  | { phase: "dragging" }
  | { phase: "importing" }
  | { phase: "success"; result: ImportResult }
  | { phase: "error"; message: string; details: string[] };

export type RecordsAction =
  | { type: "load_start" }
  | { type: "loaded"; records: RecordSummary[] }
  | { type: "load_failed"; message: string }
  | { type: "remove_start"; id: string }
  | { type: "removed"; id: string }
  | { type: "remove_failed"; id: string; message: string }
  | { type: "cleared" }
  | { type: "clear_failed"; message: string }
  | { type: "drag"; over: boolean }
  | { type: "import_start" }
  | { type: "imported"; result: ImportResult }
  | { type: "import_failed"; message: string; details: string[] }
  | { type: "import_dismissed" };

export const initialRecords: RecordsState = {
  phase: "loading",
  records: [],
  loadError: null,
  removing: [],
  actionError: null,
  import: { phase: "idle" },
};

export function recordsReducer(state: RecordsState, action: RecordsAction): RecordsState {
  switch (action.type) {
    case "load_start":
      // A reload after an import keeps the list on screen instead of flashing "loading".
      return state.phase === "ready" ? state : { ...state, phase: "loading", loadError: null };
    case "loaded":
      return { ...state, phase: "ready", records: action.records, loadError: null };
    case "load_failed":
      return { ...state, phase: "error", loadError: action.message };
    case "remove_start":
      return { ...state, removing: [...state.removing, action.id], actionError: null };
    case "removed":
      return {
        ...state,
        records: state.records.filter((record) => record.id !== action.id),
        removing: state.removing.filter((id) => id !== action.id),
      };
    case "remove_failed":
      return { ...state, removing: state.removing.filter((id) => id !== action.id), actionError: action.message };
    case "cleared":
      return { ...state, records: [], actionError: null, import: { phase: "idle" } };
    case "clear_failed":
      return { ...state, actionError: action.message };
    case "drag":
      if (state.import.phase === "importing") return state;
      if (action.over) return { ...state, import: { phase: "dragging" } };
      return state.import.phase === "dragging" ? { ...state, import: { phase: "idle" } } : state;
    case "import_start":
      return { ...state, import: { phase: "importing" } };
    case "imported":
      return { ...state, import: { phase: "success", result: action.result } };
    case "import_failed":
      return { ...state, import: { phase: "error", message: action.message, details: action.details } };
    case "import_dismissed":
      return { ...state, import: { phase: "idle" } };
  }
}
