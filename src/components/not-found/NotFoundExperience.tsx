"use client";

import Image from "next/image";
import { APP_NAME } from "@/lib/brand";
import styles from "./not-found.module.css";

export type MissingKind = "page" | "organisation" | "suspended";
export type MissingDesign = "card" | "map" | "ticket";

const copy = {
  page: {
    eyebrow: "404 / PAGE NOT FOUND",
    title: "This one slipped off the board.",
    description: "We couldn’t find this page. The link may have changed, or this page may not be available to you.",
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
    note: "This page will return when access is restored.",
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

function MapArt({ paused }: { paused: boolean }) {
  return (
    <div className={styles.mapArt} aria-hidden="true">
      <div className={styles.mapGrid} />
      <div className={styles.orbit}><span /><span /><span /></div>
      <div className={styles.mapNumber}>{paused ? "Ⅱ" : "404"}</div>
      <div className={styles.mapLabel}>YOU ARE HERE</div>
      <div className={styles.waypoint}><i />Projects</div>
      <div className={styles.destination}>{paused ? "Access on hold" : "Unknown destination"}<span>×</span></div>
      <svg className={styles.routeLine} viewBox="0 0 520 300" preserveAspectRatio="none" fill="none">
        <path className={styles.desktopRoute} d="M100 234 H184 Q202 234 202 216 V186 Q202 168 220 168 H320 Q346 168 346 142 V104 Q346 82 368 82 H419" stroke="currentColor" strokeWidth="2" strokeDasharray="5 7" />
        <path className={styles.mobileRoute} d="M110 239 H185 Q205 239 205 219 Q205 202 225 202 H270" stroke="currentColor" strokeWidth="2" strokeDasharray="5 7" />
      </svg>
      <div className={styles.mapCoordinates}>BOARD / {paused ? "PAUSED" : "UNMAPPED"}</div>
    </div>
  );
}

function TicketArt({ paused }: { paused: boolean }) {
  return (
    <div className={styles.ticketArt} aria-hidden="true">
      <span className={styles.ticketBack} />
      <div className={styles.ticket}>
        <div className={styles.ticketHeader}><span>BOARD PLANNER</span><span>{paused ? "HOLD" : "LOST & FOUND"}</span></div>
        <div className={styles.ticketNumber}>{paused ? "Ⅱ" : "404"}<span>{paused ? "ACCESS ON PAUSE" : "ONE PAGE MISSING"}</span></div>
        <div className={styles.ticketRule} />
        <div className={styles.ticketStub}><span>{paused ? "KEEP YOUR BOARDS" : "RETURN TO PROJECTS"}<small>{paused ? "Access can be restored" : "No detour required"}</small></span><div className={styles.barcode} /></div>
      </div>
      <span className={styles.ticketAnnotation}>{paused ? "kept, not gone." : "keep the plan. lose the dead end."}</span>
    </div>
  );
}

/** A resource and an inaccessible resource deliberately have exactly the same copy. */
export function NotFoundExperience({
  kind = "page",
  design = "card",
  standalone = false,
  signIn,
}: {
  kind?: MissingKind;
  design?: MissingDesign;
  standalone?: boolean;
  signIn?: string | null;
}) {
  const content = copy[kind];
  const title = kind === "page" && design === "map" ? "A little outside the plan."
    : kind === "page" && design === "ticket" ? "Good plans. Bad links."
    : content.title;
  const href = kind === "page" ? "/projects" : signIn ? `${signIn}/?switch` : "/?switch";

  return (
    <section className={`${styles.experience} ${standalone ? styles.standalone : ""}`} data-testid={kind === "organisation" ? "no-organisation-here" : `missing-${kind}`}>
      {standalone && <div className={styles.brand}><Image src="/logo.svg" alt="" width={26} height={26} /><span>{APP_NAME}</span></div>}
      <div className={styles.composition}>
        {design === "card" ? <CardArt paused={kind === "suspended"} /> : design === "map" ? <MapArt paused={kind === "suspended"} /> : <TicketArt paused={kind === "suspended"} />}
        <div className={styles.text}>
          <p className={styles.eyebrow}>{content.eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.description}>{content.description}</p>
          {content.action && <a href={href} className={`focus-ring ${styles.action}`}>{content.action}<span aria-hidden="true">→</span></a>}
          <p className={styles.note}>{content.note}</p>
        </div>
      </div>
    </section>
  );
}
