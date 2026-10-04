"use client";

/**
 * Schaltfläche (`Button`) mit den vier Rollen der Oberfläche (v0.15.0).
 *
 * Vorher hatte jede Schaltfläche ihre eigene Klassenzusammensetzung —
 * Hover-Zustand, Fokusring und Deaktiviert-Optik unterschieden sich dadurch
 * von Panel zu Panel. Diese Komponente ist die einzige Quelle.
 *
 * Rollen: `primary` (Hauptaktion, grün), `info` (Markt-Tick/Aktualisieren,
 * blau), `danger` (Not-Halt, rot), `subtle` (alles Neutrale, Standard).
 * `iconOnly` blendet die Beschriftung optisch aus und verlangt `ariaLabel`.
 */

import { cx } from "./cx";
import {
  BUTTON_DANGER,
  BUTTON_INFO,
  BUTTON_PRIMARY,
  BUTTON_SUBTLE,
} from "./layout";

export type ButtonVariant = "primary" | "info" | "danger" | "subtle";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: BUTTON_PRIMARY,
  info: BUTTON_INFO,
  danger: BUTTON_DANGER,
  subtle: BUTTON_SUBTLE,
};

export default function Button({
  children,
  variant = "subtle",
  /** Kompaktere Höhe für Filter-/Werkzeugleisten. */
  size = "md",
  /** Während `true` wird der Knopf gesperrt und `aria-busy` gesetzt. */
  busy = false,
  /** Optisch aktiv (z. B. gewählter Filter) — unabhängig vom Hover-Zustand. */
  active = false,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  busy?: boolean;
  active?: boolean;
}) {
  return (
    <button
      {...rest}
      aria-busy={busy || undefined}
      disabled={rest.disabled || busy}
      className={cx(
        VARIANT_CLASS[variant],
        size === "sm" && "px-2.5 py-1.5 text-xs",
        active && "ring-1 ring-emerald-400/70",
        className
      )}
    >
      {children}
    </button>
  );
}
