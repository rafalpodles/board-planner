"use client";

import { useState } from "react";
import Image from "next/image";
import { useTheme } from "@/components/ThemeProvider";
import { NotFoundExperience, type MissingDesign, type MissingKind } from "./NotFoundExperience";
import styles from "./proposals.module.css";

const designs: { id: MissingDesign; label: string; subtitle: string }[] = [
  { id: "card", label: "01 / Zagubiona karta", subtitle: "Karta, która wypadła z tablicy. Trochę humoru, dużo Board Plannera." },
  { id: "map", label: "02 / Poza mapą", subtitle: "Plan ma drogę powrotną. Nawet gdy link prowadzi w nieznane." },
  { id: "ticket", label: "03 / Ślad po stronie", subtitle: "Bilet do powrotu. Oszczędna typografia i papierowy detal." },
];

export function NotFoundProposals() {
  const [design, setDesign] = useState<MissingDesign>("card");
  const [kind, setKind] = useState<MissingKind>("page");
  const { theme, setPreference } = useTheme();

  return (
    <div className={styles.preview}>
      <header className={styles.toolbar}>
        <div className={styles.title}><span>BP–262</span><h1>Mały błąd. Dobry powrót.</h1></div>
        <button className="focus-ring" onClick={() => setPreference(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀ Jasny motyw" : "☾ Ciemny motyw"}</button>
      </header>
      <div className={styles.choices} aria-label="Kierunek wizualny">
        {designs.map((item) => <button key={item.id} className="focus-ring" aria-pressed={design === item.id} onClick={() => setDesign(item.id)}>{item.label}{item.id === "card" && <span>Propozycja</span>}</button>)}
      </div>
      <div className={styles.context}>
        <p>{designs.find((item) => item.id === design)?.subtitle}</p>
        <label>Scenariusz<select className="focus-ring" value={kind} onChange={(event) => setKind(event.target.value as MissingKind)}><option value="page">Strona / zasób niedostępny</option><option value="organisation">Nieznana organizacja</option><option value="suspended">Organizacja zawieszona</option></select></label>
      </div>
      <div className={styles.app}>
        {kind === "page" && <aside className={styles.sidebar}>
          <div className={styles.logo}><Image src="/logo.svg" alt="" width={25} height={25} />Board Planner</div>
          <div className={styles.search}>⌕ <span>Search anything</span><kbd>⌘ K</kbd></div>
          <div className={styles.navigation}><span>▦ <strong>Projects</strong></span><span>✓ <strong>My tasks</strong></span><span>▧ <strong>Notifications</strong></span></div>
          <p className={styles.projectLabel}>YOUR PROJECTS</p>
          <span className={styles.project}>▱ <span>Board Planner</span><small>BP</small></span>
          <span className={styles.project}>▱ <span>Website</span><small>WEB</small></span>
          <div className={styles.account}><span>RP</span><div>Rafal<small>Personal workspace</small></div><span>⌄</span></div>
        </aside>}
        <div className={styles.canvas}>
          <div className={styles.address}><span>{kind === "page" ? "Projects / Page not found" : "Board Planner / Organisation"}</span><span>· · ·</span></div>
          <NotFoundExperience design={design} kind={kind} standalone={kind !== "page"} signIn="https://login.board-planner.com" />
        </div>
      </div>
      <p className={styles.footer}>Trzy kierunki · jeden spokojny komunikat dla brakującego zasobu i braku dostępu · ten sam motyw co aplikacja</p>
    </div>
  );
}
