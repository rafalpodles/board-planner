"use client";

import Image from "next/image";
import type { ReactNode, Ref } from "react";
import { MISSING_PAGE_MESSAGE } from "@/lib/board-load-failure";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { APP_NAME } from "@/lib/brand";
import styles from "./not-found.module.css";

export type MissingKind = "page" | "organisation" | "suspended";

const copy = {
  page: {
    eyebrow: "404 / PAGE NOT FOUND",
    title: "This one slipped off the board.",
    description: MISSING_PAGE_MESSAGE,
    action: "Back to projects",
    note: "Your next move is still on the board.",
  },
  organisation: {
    eyebrow: "404 / ORGANISATION NOT FOUND",
    title: "Right tool. Wrong address.",
    description: "There’s no organisation at this address. Check the link, or use your e-mail address to find your organisation.",
    action: "Find my organisation",
    note: "A fresh start is one sign-in away.",
  },
  suspended: {
    eyebrow: "ORGANISATION / ON PAUSE",
    title: "This organisation is suspended",
    description: "Its boards and data are kept, but nobody can use them until the service lifts the suspension. Contact the person who runs your account with the service.",
    action: "",
    note: "Your boards are kept while access is on hold.",
  },
} as const;

function CardArt({ paused }: { paused: boolean }) {
  return (
    <div className={`${styles.cardArt} ${paused ? styles.paused : ""}`} aria-hidden="true">
      <div className={styles.boardBase}>
        {["TO DO", "IN PROGRESS", "DONE"].map((label, index) => (
          <div className={styles.artColumn} key={label}>
            <span className={styles.columnLabel}><i />{label}</span>
            <div className={styles.ghostCard}><span /><span /></div>
            {index !== 1 && <div className={styles.ghostCard}><span /><span /></div>}
            {index === 1 && <div className={styles.emptySlot}>?</div>}
          </div>
        ))}
      </div>
      <div className={styles.looseCard}>
        <div className={styles.cardMeta}><span>{paused ? "ON HOLD" : "PAGE–404"}</span><span>···</span></div>
        <div className={styles.cardNumber}>{paused ? "Ⅱ" : "404"}</div>
        <span className={styles.cardCaption}>{paused ? "Waiting for access" : "A little off track"}</span>
        <div className={styles.cardFooter}><span className={styles.missingChip}>{paused ? "Paused" : "Not found"}</span><i>?</i></div>
      </div>
      <span className={styles.artAnnotation}>{paused ? "boards safely kept" : "not in this sprint, apparently"}</span>
    </div>
  );
}

/** A resource and an inaccessible resource deliberately have exactly the same copy. */
export function NotFoundExperience({
  kind = "page",
  standalone = false,
  signIn,
  description,
  detail,
  children,
  headingRef,
  actionHref,
  actionLabel,
}: {
  kind?: MissingKind;
  standalone?: boolean;
  signIn?: string | null;
  description?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  actionHref?: string;
  actionLabel?: string;
}) {
  const content = copy[kind];
  useDocumentTitle(`${kind === "suspended" ? "Organisation suspended" : kind === "organisation" ? "Organisation not found" : "Page not found"} — ${APP_NAME}`);
  const href = actionHref ?? (kind === "page" ? "/projects" : signIn ? `${signIn}/?switch` : "/?switch");
  const action = actionLabel ?? content.action;

  return (
    <section className={`${styles.experience} ${standalone ? styles.standalone : ""}`} role={kind === "suspended" ? "status" : "alert"} data-testid={kind === "organisation" ? "no-organisation-here" : `missing-${kind}`}>
      {standalone && <div className={styles.brand}><Image src="/logo.svg" alt="" width={26} height={26} /><span>{APP_NAME}</span></div>}
      <div className={styles.composition}>
        <CardArt paused={kind === "suspended"} />
        <div className={styles.text}>
          <p className={styles.eyebrow}>{content.eyebrow}</p>
          <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{content.title}</h1>
          {detail}
          <p className={styles.description}>{description ?? content.description}</p>
          {(action || children) && <div className={styles.actions}>
            {action && <a href={href} className={`focus-ring ${styles.action}`}>{action}<span aria-hidden="true">→</span></a>}
            {children}
          </div>}
          <p className={styles.note}>{content.note}</p>
        </div>
      </div>
    </section>
  );
}
