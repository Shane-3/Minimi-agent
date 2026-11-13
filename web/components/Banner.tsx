import type { ReactNode } from "react";
import styles from "./Banner.module.css";

interface BannerProps {
  tone: "info" | "danger";
  children: ReactNode;
}

/** A one-line notice under the header: missing key, offline, search off, database error. */
export function Banner({ tone, children }: BannerProps) {
  return <div className={`${styles.banner} ${tone === "danger" ? styles.danger : ""}`}>{children}</div>;
}
