import type { MemoryChip as Chip } from "../../shared/types.ts";
import { dayLabel } from "../format.ts";
import styles from "./MemoryChip.module.css";

interface MemoryChipProps {
  chip: Chip;
  timezone: string;
  onOpen: () => void;
}

/** A record the answer drew on: "Acme renewal call · Mon 9 Nov". Opens the record (U3). */
export function MemoryChip({ chip, timezone, onOpen }: MemoryChipProps) {
  return (
    <button type="button" className={styles.chip} onClick={onOpen}>
      {chip.title} · {dayLabel(chip.startedAt, timezone)}
    </button>
  );
}
