"use client";

/**
 * Vollständiger Dateibaum der Doku (`docs/**`) — aufklappbar und durchsuchbar.
 *
 * Der Katalog führt nur die kuratierten Einstiegsdokumente. Die ~250
 * Detailseiten (Audit-Findings, Prompts, Remediation-Berichte) waren dadurch
 * im Browser nicht erreichbar, obwohl sie offline im Repo liegen. Dieser Baum
 * macht sie sichtbar — er wird erst beim Aufklappen geladen (`?tree=1`), damit
 * die Übersicht schnell bleibt.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { ChevronIcon, FileIcon, SearchIcon } from "./DocsIcons";

type TreeNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  title: string;
  subtitle?: string;
  cataloged?: boolean;
  children?: TreeNode[];
};

function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.type === "file" ? 1 : countFiles(n.children ?? [])), 0);
}

/** Baum nach Suchbegriff filtern — ein Ordner bleibt, wenn ein Kind passt. */
function filterTree(nodes: TreeNode[], terms: string[]): TreeNode[] {
  if (terms.length === 0) return nodes;
  const out: TreeNode[] = [];
  for (const node of nodes) {
    const self = `${node.name} ${node.title} ${node.subtitle ?? ""} ${node.path}`.toLowerCase();
    const selfMatch = terms.every((t) => self.includes(t));
    if (node.type === "file") {
      if (selfMatch) out.push(node);
      continue;
    }
    const children = filterTree(node.children ?? [], terms);
    if (children.length > 0) out.push({ ...node, children });
    else if (selfMatch && node.children) out.push(node);
  }
  return out;
}

function TreeBranch({
  nodes,
  depth,
  openDirs,
  toggleDir,
  onNavigate,
}: {
  nodes: TreeNode[];
  depth: number;
  openDirs: Set<string>;
  toggleDir: (path: string) => void;
  onNavigate?: () => void;
}) {
  return (
    <ul className={depth === 0 ? "space-y-0.5" : "space-y-0.5 border-l border-slate-800 pl-2"}>
      {nodes.map((node) => {
        if (node.type === "dir") {
          const open = openDirs.has(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                onClick={() => toggleDir(node.path)}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] text-slate-300 hover:bg-slate-800/60"
              >
                <ChevronIcon
                  className={`h-2.5 w-2.5 shrink-0 text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}
                />
                <span className="font-medium">{node.title}</span>
                <span className="text-[10px] text-slate-500">({countFiles(node.children ?? [])})</span>
              </button>
              {open && (
                <div className="mt-0.5">
                  <TreeBranch
                    nodes={node.children ?? []}
                    depth={depth + 1}
                    openDirs={openDirs}
                    toggleDir={toggleDir}
                    onNavigate={onNavigate}
                  />
                </div>
              )}
            </li>
          );
        }
        return (
          <li key={node.path}>
            <Link
              href={node.path}
              onClick={onNavigate}
              title={node.subtitle ?? node.path}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12.5px] text-slate-400 hover:bg-slate-800/60 hover:text-slate-100"
            >
              <FileIcon className="h-3 w-3 shrink-0 text-slate-600" />
              <span className="min-w-0 break-words">
                {node.title}
                {node.cataloged && (
                  <span className="ml-1.5 rounded bg-emerald-500/15 px-1 py-px text-[9px] uppercase tracking-wide text-emerald-300">
                    Katalog
                  </span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function DocsFileTree() {
  const [open, setOpen] = useState(false);
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set(["/docs/audits", "/docs/security"]));

  /**
   * Baum erst beim Aufklappen laden — aus dem Klick heraus, nicht aus einem
   * Effect: kein `setState` während des Renderns/Effekts, kein Doppel-Request
   * bei schnellem Auf-/Zuklappen (react-hooks/set-state-in-effect).
   */
  const loadTree = () => {
    if (tree !== null || loading) return;
    setLoading(true);
    fetch("/api/docs?tree=1")
      .then((r) => r.json())
      .then((d: { tree?: TreeNode[] }) => setTree(d.tree ?? []))
      .catch(() => setTree([]))
      .finally(() => setLoading(false));
  };

  const toggleOpen = () => {
    // Bewusst außerhalb des Updaters: State-Updater müssen rein bleiben
    // (React darf sie doppelt aufrufen) — der Request hängt am Klick.
    const next = !open;
    setOpen(next);
    if (next) loadTree();
  };

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredTree = useMemo(() => (tree ? filterTree(tree, terms) : null), [tree, terms]);
  const searching = terms.length > 0;

  // Während der Suche alle Ordner der Treffer öffnen.
  const effectiveOpen = useMemo(() => {
    if (!searching || !filteredTree) return openDirs;
    const all = new Set<string>();
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === "dir") {
          all.add(n.path);
          collect(n.children ?? []);
        }
      }
    };
    collect(filteredTree);
    return all;
  }, [searching, filteredTree, openDirs]);

  const toggleDir = (path: string) =>
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <section
      aria-labelledby="docs-tree-heading"
      className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/40"
    >
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-2xl px-4 py-3 text-left sm:px-5"
      >
        <ChevronIcon
          className={`h-3 w-3 shrink-0 text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1">
          <span id="docs-tree-heading" className="block text-sm font-semibold text-slate-100">
            Vollständiger Dateibaum (docs/)
          </span>
          <span className="mt-0.5 block text-[11.5px] text-slate-500">
            Alle Markdown-Dateien inkl. Audit-Findings, Prompts und Archiv — auch die, die nicht im Katalog stehen.
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-800 px-4 py-3 sm:px-5">
          <div className="relative mb-3 max-w-md">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Pfad oder Titel durchsuchen…"
            aria-label="Dateibaum durchsuchen"
            className="w-full rounded-lg border border-slate-700 bg-slate-950/60 py-2 pl-8 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/70 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          </div>
          {loading && <p className="text-xs text-slate-500">Lade Dateibaum…</p>}
          {!loading && filteredTree && filteredTree.length === 0 && (
            <p className="text-xs text-slate-500">Kein Treffer.</p>
          )}
          {!loading && filteredTree && filteredTree.length > 0 && (
            <>
              {searching && (
                <p className="mb-2 text-[11px] text-slate-500">
                  {countFiles(filteredTree)} Treffer
                </p>
              )}
              <div className="max-h-[60vh] overflow-y-auto pr-1">
                <TreeBranch
                  nodes={filteredTree}
                  depth={0}
                  openDirs={effectiveOpen}
                  toggleDir={toggleDir}
                />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
