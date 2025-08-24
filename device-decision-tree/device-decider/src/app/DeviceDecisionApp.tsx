"use client";

import React, { useMemo, useState } from "react";
import DecisionTreeViz, { AppTreeNode } from "./DecisionTreeViz"; // adjust path if needed


/**
 * DeviceDecisionApp.tsx
 *
 * Adds CONFIG control for which columns are used as HARD CONSTRAINTS
 * — without hiding them from tradeoffs:
 *
 *  - config.constraints.includeColumns: string[]  // only these are constraint columns
 *  - config.constraints.excludeColumns: string[]  // everything except these (ignored for constraints only)
 *  - config.ignoredColumns: string[]              // hides from BOTH constraints & tradeoffs
 *  - config.columnAliases: { alias -> realColumn }
 *  - config.constraints.defaults / overrides      // as before
 *  - config.tradeoffs.selected/defaults/overrides // as before
 */

type Row = Record<string, string | number | boolean>;

type ParsedCSV = {
  headers: string[];
  rows: Row[];
};

type NumericConstraint = { min?: number; max?: number };

type CategoricalConstraint = { includes?: string; exact?: boolean };

type BooleanConstraint = { value?: boolean };

type Constraint = NumericConstraint | CategoricalConstraint | BooleanConstraint;

type Tradeoff = { key: string; weight: number; direction: "higher" | "lower" };


type Contribution = {
  key: string;
  value: number;
  normalized: number;
  weight: number;
  directedComponent: number;
  contribution: number;
};

// ---- Types ----
export type ScoredRow = {
  __score: number;              // numeric target we want to "optimize/explain"
  __contribs: Contribution[];   // contribution breakdown for each tradeoff
  [k: string]: any;
};

type NumericFeature = {
  kind: "numeric";
  name: string;                 // key in ScoredRow, e.g. "price_inr" or "battery_hours_min"
  // Optional preset thresholds (else auto-derive from data)
  thresholds?: number[];
};

type CategoricalFeature = {
  kind: "categorical";
  name: string;                 // key in ScoredRow
};

export type Feature = NumericFeature | CategoricalFeature;

export type LeafNode = {
  id: string;
  kind: "leaf";
  prediction: number;           // mean score in this leaf
  rows: ScoredRow[];            // keep for UI / drilldown
};

export type InnerNode = {
  id: string;
  kind: "node";
  feature: string;
  // For numeric splits: row[feature] <= threshold ? left : right
  threshold?: number;
  // For categorical splits: row[feature] === category ? left : right
  category?: string;
  question: string;             // human-readable prompt for the UI
  left: TreeNode;
  right: TreeNode;
  // optional: diagnostics for tooltips
  stats?: { n: number; varBefore: number; varAfter: number; gain: number };
};

export type TreeNode = LeafNode | InnerNode;

export type BuildOptions = {
  maxDepth?: number;            // e.g. 4–6
  minSamplesSplit?: number;     // e.g. 8
  minSamplesLeaf?: number;      // e.g. 3
  idPrefix?: string;            // default "n"
  // If you want deterministic yet "balanced-ish", sort candidate thresholds and try midpoints.
};

// ---- Utilities ----
const mean = (xs: number[]) => xs.reduce((a,b)=>a+b,0) / Math.max(xs.length,1);

const variance = (xs: number[]) => {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  return xs.reduce((s,x)=>s+(x-m)*(x-m),0) / (xs.length - 1);
};

function sse(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let sum = 0;
  for (const x of xs) {
    const d = x - m;
    sum += d * d;
  }
  return sum;
}

// Compute variance reduction for a candidate split
function splitScoreSSE(rows: ScoredRow[], left: ScoredRow[], right: ScoredRow[]) {
  const yAll = rows.map(r => r.__score);
  const yL   = left.map(r => r.__score);
  const yR   = right.map(r => r.__score);

  const sseBefore = sse(yAll);
  const sseAfter  = sse(yL) + sse(yR);
  const gain      = sseBefore - sseAfter;

  // For diagnostics, report MSE (SSE/N) so numbers feel comparable to “variance”
  const n = Math.max(yAll.length, 1);
  const vBefore = sseBefore / n;
  const vAfter  = sseAfter  / n;

  return { vBefore, vAfter, gain };
}

// Generate numeric thresholds (unique sorted midpoints) if not provided
function candidateThresholdsNumeric(rows: ScoredRow[], feature: string, maxCandidates = 16): number[] {
  const vals = rows
    .map(r => r[feature])
    .filter(v => typeof v === "number" && Number.isFinite(v)) as number[];
  const uniq = Array.from(new Set(vals)).sort((a,b)=>a-b);
  if (uniq.length <= 1) return [];
  // Midpoints between consecutive unique values
  const mids: number[] = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    mids.push((uniq[i] + uniq[i+1]) / 2);
  }
  // Downsample for speed
  if (mids.length > maxCandidates) {
    const step = mids.length / maxCandidates;
    const picked: number[] = [];
    for (let i = 0; i < maxCandidates; i++) picked.push(mids[Math.floor(i * step)]);
    return picked;
  }
  return mids;
}

// Generate categorical categories present
// Helper: normalize any categorical-ish value to a string token
function catToken(v: unknown): string {
  if (v === null || v === undefined) return "";
  // stringify and lower for case-insensitive matching
  return String(v).toLowerCase();
}

// Generate categorical categories present (strings OR booleans)
function candidateCategories(rows: ScoredRow[], feature: string): string[] {
  const vals = rows.map(r => r[feature]).filter(v => v !== undefined);
  const toks = vals.map(catToken);
  return Array.from(new Set(toks));
}


// ---- Core builder (CART-style regression tree) ----
export function buildDecisionTree(
  rows: ScoredRow[],
  features: Feature[],
  opts: BuildOptions = {}
): TreeNode {
  const {
    maxDepth = 5,
    minSamplesSplit = 8,
    minSamplesLeaf = 3,
    idPrefix = "n",
  } = opts;

  function makeLeaf(id: string, group: ScoredRow[]): LeafNode {
    return {
      id,
      kind: "leaf",
      prediction: mean(group.map(r => r.__score)),
      rows: group
    };
  }

  function bestSplit(group: ScoredRow[]) {
    let best:
      | {
          feature: string;
          threshold?: number;
          category?: string;
          left: ScoredRow[];
          right: ScoredRow[];
          vBefore: number;
          vAfter: number;
          gain: number;
          question: string;
        }
      | null = null;

      for (const f of features) {
        const distinct = new Set(group.map(r => r[f.name]).filter(v => v !== undefined && v !== null));
        
        if (f.kind === "numeric") {
          const thresholds = f.thresholds ?? candidateThresholdsNumeric(group, f.name);
          
          for (const t of thresholds) {
            const left  = group.filter(r => typeof r[f.name] === "number" && r[f.name] <= t);
            const right = group.filter(r => typeof r[f.name] === "number" && r[f.name] >  t);
            
            const { vBefore, vAfter, gain } = splitScoreSSE(group, left, right);
            
            if (!best || gain > best.gain) {
              best = {
                feature: f.name,
                threshold: t,
                left, right, vBefore, vAfter, gain,
                question: `${f.name} ≤ ${Number.isInteger(t) ? t : t.toFixed(2)}?`,
              };
            }
          }
        } else { // categorical
          const cats = candidateCategories(group, f.name);
          
          for (const c of cats) {
            const left  = group.filter(r => catToken(r[f.name]) === c);
            const right = group.filter(r => catToken(r[f.name]) !== c);
            const { vBefore, vAfter, gain } = splitScoreSSE(group, left, right);
            
            if (!best || gain > best.gain) {
              best = {
                feature: f.name,
                category: c,
                left, right, vBefore, vAfter, gain,
                question: `${f.name} = "${c}"?`,
              };
            }
          }
        }
      }
      
    return best;
  }

  function rec(group: ScoredRow[], depth: number, idPath: string): TreeNode {

    
    // Stopping criteria
    if (group.length < minSamplesSplit || depth >= maxDepth) {
      console.log(`[buildDecisionTree] Stopping due to group.length < minSamplesSplit or depth >= maxDepth:`, {
        groupLength: group.length,
        minSamplesSplit,
        depth,
        maxDepth
      });
      return makeLeaf(`${idPrefix}_${idPath || "root"}`, group);
    }
    
    const y = group.map(r => r.__score);
    const yVariance = variance(y);
    
    if (yVariance === 0) {
      console.log(`[buildDecisionTree] Stopping due to zero variance in scores`);
      return makeLeaf(`${idPrefix}_${idPath || "root"}`, group);
    }

    const split = bestSplit(group);

    
    if (!split || split.gain <= 1e-12) {
      console.log(`[buildDecisionTree] Stopping due to no valid split or gain <= 0:`, {
        hasSplit: !!split,
        gain: split?.gain
      });
      return makeLeaf(`${idPrefix}_${idPath || "root"}`, group);
    }

    const nodeId = `${idPrefix}_${idPath || "root"}`;
    const leftNode = rec(split.left,  depth + 1, idPath + "L");
    const rightNode = rec(split.right, depth + 1, idPath + "R");

    const stats = { n: group.length, varBefore: split.vBefore, varAfter: split.vAfter, gain: split.gain };

    if (split.threshold !== undefined) {
      return {
        id: nodeId,
        kind: "node",
        feature: split.feature,
        threshold: split.threshold,
        question: split.question,
        left: leftNode,
        right: rightNode,
        stats
      };
    } else {
      return {
        id: nodeId,
        kind: "node",
        feature: split.feature,
        category: split.category!,
        question: split.question,
        left: leftNode,
        right: rightNode,
        stats
      };
    }
  }

  return rec(rows, 0, "");
}

// ----------------------------- Config Schema ------------------------------ //

type AppConfig = {
  ignoredColumns?: string[]; // hidden everywhere
  columnAliases?: Record<string, string>;
  constraints?: {
    includeColumns?: string[]; // constraint panel & filtering ONLY
    excludeColumns?: string[]; // constraint panel & filtering ONLY
    defaults?: {
      numeric?: { useDatasetRange?: boolean; min?: number | null; max?: number | null };
      categorical?: { includes?: string; exact?: boolean };
    };
    overrides?: Record<string, NumericConstraint | CategoricalConstraint | BooleanConstraint>;
  };
  tradeoffs?: {
    selected?: string[];
    defaults?: { weight?: number; direction?: "higher" | "lower" };
    overrides?: Record<string, Partial<Pick<Tradeoff, "weight" | "direction">>>;
  };
};


// ----------------------------- CSV Parsing ------------------------------ //

function parseCSV(text: string): ParsedCSV {
  const rows: string[][] = [];
  let field = "";
  let inQuotes = false;

  rows.push([]);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        rows[rows.length - 1].push(field);
        field = "";
      } else if (c === '\n') {
        rows[rows.length - 1].push(field);
        field = "";
        rows.push([]);
      } else if (c === '\r') {
        // ignore CR; handle CRLF in the \n case
      } else {
        field += c;
      }
    }
  }
  // push last field
  rows[rows.length - 1].push(field);

  // Trim trailing empty row if present (caused by trailing newline)
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).filter((r) => r.some((v) => v.trim() !== ""));

  const coerced: Row[] = dataRows.map((r) => {
    const obj: Row = {};
    headers.forEach((h, idx) => {
      const raw = r[idx] ?? "";
      const v = tryCoerceValue(raw);
      obj[h] = v;
    });
    return obj;
  });

  return { headers, rows: coerced };
}

function isSimpleNumberString(t: string): boolean {
  if (!t) return false; let dot = 0, sign = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '.') { if (++dot > 1) return false; }
    else if (ch === '-') { if (i !== 0 || ++sign > 1) return false; }
    else if (ch < '0' || ch > '9') return false;
  }
  return !(t === '-' || t === '.' || t === '-.');
}

function tryCoerceValue(s: string): string | number | boolean {
  const t = s.trim();
  if (t === "") return "";
  if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) return t;
  const tl = t.toLowerCase();
  if (tl === "true") return true;
  if (tl === "false") return false;
  const n = Number(t);
  return Number.isFinite(n) && isSimpleNumberString(t) ? n : t;
}

// ----------------------------- Helpers ------------------------------ //

function summarizeBooleanCounts(rows: Row[], keys: string[]) {
  return keys.map((key) => {
    let trueCount = 0, falseCount = 0, otherCount = 0;
    for (const r of rows) {
      const v = r[key];
      if (typeof v === "boolean") (v ? trueCount++ : falseCount++);
      else if (v !== undefined) otherCount++;
    }
    return { key, trueCount, falseCount, otherCount, total: rows.length };
  });
}

// ----------------------------- Helpers ------------------------------ //

function isNumericColumn(rows: Row[], key: string): boolean {
  return rows.some((r) => typeof r[key] === "number");
}

function isBooleanColumn(rows: Row[], key: string): boolean {
  return rows.some((r) => typeof r[key] === "boolean");
}

function getMinMax(rows: Row[], key: string): { min: number; max: number } | null {
  const nums = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
  if (!nums.length) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

function ciEq(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }

function resolveKey(key: string, headers: string[], cfg: AppConfig | null): string | null {
  const candidates = [key];
  const alias = cfg?.columnAliases?.[key];
  if (alias) candidates.unshift(alias);
  for (const c of candidates) {
    const found = headers.find((h) => ciEq(h, c));
    if (found) return found;
  }
  return null;
}

function resolveColumnList(keys: string[] | undefined, headers: string[], cfg: AppConfig | null): string[] {
  if (!keys || !keys.length) return [];
  const out: string[] = [];
  for (const k of keys) {
    const hk = resolveKey(k, headers, cfg);
    if (hk) out.push(hk);
  }
  return Array.from(new Set(out));
}

function makeFeatures(numeric: string[], booleanCols: string[], categorical: string[]): Feature[] {
  const feats: Feature[] = [];
  for (const n of numeric) feats.push({ kind: "numeric", name: n });
  for (const b of booleanCols) feats.push({ kind: "categorical", name: b });
  for (const c of categorical) feats.push({ kind: "categorical", name: c });
  return feats;
}


// pick a representative row for a leaf (top score)
function representativeRow(rows: ScoredRow[], fallbackScore: number): ScoredRow {
  const best = [...rows].sort((a, b) => b.__score - a.__score)[0];
  if (best) return best;
  // synthesize a minimal row if empty
  return { __score: fallbackScore, __contribs: [] } as ScoredRow;
}

// ✅ new converter that matches DecisionTreeViz expectations
function toAppTree(node: TreeNode): AppTreeNode {
  if (node.kind === "leaf") {
    const row = representativeRow(node.rows, node.prediction);
    return { id: node.id, row, left: null, right: null };
  }
  // inner nodes don't need real contribs; viz falls back to "Score split"
  const synthetic: ScoredRow = { __score: 0, __contribs: [] } as any;
  return {
    id: node.id,
    row: synthetic,
    left: node.left ? toAppTree(node.left) : null,
    right: node.right ? toAppTree(node.right) : null,
  };
}

// ----------------------------- Constraints ------------------------------ //

function applyConstraints(rows: Row[], constraints: Record<string, Constraint>, headers: string[]): Row[] {
  return rows.filter((row) => {
    for (const key of headers) {
      const c = constraints[key];
      if (!c) continue;
      const v = row[key];
      if (typeof v === "number") {
        const nc = c as NumericConstraint;
        if (nc.min !== undefined && v < nc.min) return false;
        if (nc.max !== undefined && v > nc.max) return false;
      } else if (typeof v === "boolean") {
        const bc = c as BooleanConstraint;
        if (typeof bc.value === "boolean" && v !== bc.value) return false;
      } else {
        const cc = c as CategoricalConstraint;
        const term = (v ?? "").toString();
        if (cc.includes && cc.includes.trim() !== "") {
          const tokens = cc.includes.split(",").map((x) => x.trim()).filter(Boolean);
          if (tokens.length) {
            const matched = tokens.some((tok) =>
              cc.exact ? term.toLowerCase() === tok.toLowerCase() : term.toLowerCase().includes(tok.toLowerCase())
            );
            if (!matched) return false;
          }
        }
      }
    }
    return true;
  });
}

// Diagnostic helper: find first failing key for a row given current constraints
function firstFailingKey(row: Row, constraints: Record<string, Constraint>, headers: string[]): string | null {
  for (const key of headers) {
    const c = constraints[key];
    if (!c) continue;
    const v = row[key];
    if (typeof v === "number") {
      const nc = c as NumericConstraint;
      if (nc.min !== undefined && v < nc.min) return key;
      if (nc.max !== undefined && v > nc.max) return key;
    } else if (typeof v === "boolean") {
      const bc = c as BooleanConstraint;
      if (typeof bc.value === "boolean" && v !== bc.value) return key;
    } else {
      const cc = c as CategoricalConstraint;
      const term = (v ?? "").toString();
      if (cc.includes && cc.includes.trim() !== "") {
        const tokens = cc.includes.split(",").map((x) => x.trim()).filter(Boolean);
        if (tokens.length) {
          const matched = tokens.some((tok) =>
            cc.exact ? term.toLowerCase() === tok.toLowerCase() : term.toLowerCase().includes(tok.toLowerCase())
          );
          if (!matched) return key;
        }
      }
    }
  }
  return null;
}

function analyzeConstraintEffects(rows: Row[], constraints: Record<string, Constraint>, headers: string[]) {
  type Breakdown = {
    key: string;
    type: 'numeric' | 'boolean' | 'categorical' | 'mixed' | 'unknown';
    total: number;
    failMin?: number;
    failMax?: number;
    failBool?: number;
    failCat?: number;
  };
  const out: Record<string, Breakdown> = {};
  const total = rows.length;
  for (const key of headers) {
    const c = constraints[key];
    if (!c) continue;
    const bd: Breakdown = { key, type: 'unknown', total };
    let sawNum = false, sawBool = false, sawOther = false;
    for (const r of rows) {
      const v = r[key];
      if (typeof v === 'number') {
        sawNum = true;
        const nc = c as NumericConstraint;
        if (nc.min !== undefined && v < nc.min) bd.failMin = (bd.failMin ?? 0) + 1;
        if (nc.max !== undefined && v > nc.max) bd.failMax = (bd.failMax ?? 0) + 1;
      } else if (typeof v === 'boolean') {
        sawBool = true;
        const bc = c as BooleanConstraint;
        if (typeof bc.value === 'boolean' && v !== bc.value) bd.failBool = (bd.failBool ?? 0) + 1;
      } else {
        sawOther = true;
        const cc = c as CategoricalConstraint;
        const term = (v ?? '').toString();
        if (cc.includes && cc.includes.trim() !== '') {
          const tokens = cc.includes.split(',').map((x) => x.trim()).filter(Boolean);
          if (tokens.length) {
            const matched = tokens.some((tok) => cc.exact ? term.toLowerCase() === tok.toLowerCase() : term.toLowerCase().includes(tok.toLowerCase()));
            if (!matched) bd.failCat = (bd.failCat ?? 0) + 1;
          }
        }
      }
    }
    bd.type = sawNum && !sawBool && !sawOther ? 'numeric' : sawBool && !sawNum && !sawOther ? 'boolean' : sawOther && !sawNum && !sawBool ? 'categorical' : (sawNum || sawBool) && sawOther ? 'mixed' : 'unknown';
    out[key] = bd;
  }
  return Object.values(out).sort((a, b) => ((b.failMin ?? 0) + (b.failMax ?? 0) + (b.failBool ?? 0) + (b.failCat ?? 0)) - ((a.failMin ?? 0) + (a.failMax ?? 0) + (a.failBool ?? 0) + (a.failCat ?? 0)));
}

// ----------------------------- Optimizer ------------------------------ //

function computeScores(rows: Row[], tradeoffs: Tradeoff[], nameColumn: string): ScoredRow[] {
  
  if (rows.length === 0 || tradeoffs.length === 0) {
    return rows.map((r) => ({ ...r, __score: 0, __contribs: [] } as unknown as ScoredRow));
  }
  
  const mm: Record<string, { min: number; max: number }> = {};
  for (const t of tradeoffs) {
    mm[t.key] = getMinMax(rows, t.key) ?? { min: 0, max: 0 };
  }
  
  return rows.map((row) => {
    const contribs: Contribution[] = tradeoffs.map((t) => {
      const raw = row[t.key];
      const value = typeof raw === "number" ? raw : NaN;
      const m = mm[t.key];
      let normalized = 0;
      if (Number.isFinite(value) && m.max !== m.min) normalized = (value - m.min) / (m.max - m.min);
      const directedComponent = t.direction === "higher" ? normalized : 1 - normalized;
      const contribution = t.weight * directedComponent;
      
      return { key: t.key, value: Number.isFinite(value) ? value : NaN, normalized, weight: t.weight, directedComponent, contribution };
    });
    const __score = contribs.reduce((s, c) => s + c.contribution, 0);
    return { ...row, __score, __contribs: contribs } as unknown as ScoredRow;
  });
}



// ----------------------------- UI ------------------------------ //

const FALLBACK_DEFAULT_TRADEOFFS = ["price_inr", "learning_hours", "maintenance_hours_per_year", "power_adequacy_score"];

export default function DeviceDecisionApp() {
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Row[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [constraints, setConstraints] = useState<Record<string, Constraint>>({});
  const [selectedTradeoffs, setSelectedTradeoffs] = useState<string[]>([]);
  const [tradeoffs, setTradeoffs] = useState<Record<string, Tradeoff>>({});
  const [filteredRows, setFilteredRows] = useState<Row[]>([]);
  const [scoredRows, setScoredRows] = useState<ScoredRow[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);

  const ignoredSet = useMemo(() => new Set((config?.ignoredColumns ?? []).map((x) => x.toLowerCase())), [config]);
  const visibleHeaders = useMemo(() => csvHeaders.filter((h) => !ignoredSet.has(h.toLowerCase())), [csvHeaders, ignoredSet]);

  // NEW: constraint headers (subset of visible headers)
  const constraintHeaders = useMemo(() => {
    const inc = resolveColumnList(config?.constraints?.includeColumns, csvHeaders, config)
      .filter((h) => visibleHeaders.includes(h));
    if (inc.length) return inc;
    const excSet = new Set(resolveColumnList(config?.constraints?.excludeColumns, csvHeaders, config));
    return visibleHeaders.filter((h) => !excSet.has(h));
  }, [config, csvHeaders, visibleHeaders]);

  const nameColumn = useMemo(() => (visibleHeaders.includes("name") ? "name" : visibleHeaders[0] ?? ""), [visibleHeaders]);
  const numericColumns = useMemo(() => visibleHeaders.filter((h) => isNumericColumn(rawRows, h)), [visibleHeaders, rawRows]);
  const booleanColumns = useMemo(() => visibleHeaders.filter((h) => isBooleanColumn(rawRows, h)), [visibleHeaders, rawRows]);
  const categoricalColumns = useMemo(() => visibleHeaders.filter((h) => !isNumericColumn(rawRows, h) && !isBooleanColumn(rawRows, h)), [visibleHeaders, rawRows]);

  // ----------------- Initialization from CSV + Config ----------------- //

  function buildDefaultConstraintForKey(key: string, rows: Row[]): Constraint {
    const isNum = isNumericColumn(rows, key);
    const cdefs = config?.constraints?.defaults;
    if (isNum) {
      const useRange = cdefs?.numeric?.useDatasetRange ?? true;
      if (useRange) {
        const mm = getMinMax(rows, key) ?? { min: 0, max: 0 };
        return { min: mm.min, max: mm.max };
      }
      return { min: cdefs?.numeric?.min ?? undefined, max: cdefs?.numeric?.max ?? undefined };
    }
    if (isBooleanColumn(rows, key)) {
      return { value: undefined };
    }
    return { includes: cdefs?.categorical?.includes ?? "", exact: cdefs?.categorical?.exact ?? false };
  }

  function applyConstraintOverrides(base: Record<string, Constraint>, headers: string[], rows: Row[], cfg: AppConfig | null) {
    const over = cfg?.constraints?.overrides ?? {};
    for (const k of Object.keys(over)) {
      const hk = resolveKey(k, headers, cfg);
      if (!hk || !headers.includes(hk)) continue;
      const isNum = isNumericColumn(rows, hk);
      const isBool = isBooleanColumn(rows, hk);
      const patch = over[k] as Record<string, unknown>;
      if (isNum) {
        const prev = (base[hk] as NumericConstraint) ?? {};
        base[hk] = { 
          ...prev, 
          min: typeof patch.min === 'number' ? patch.min : prev.min, 
          max: typeof patch.max === 'number' ? patch.max : prev.max 
        };
      } else if (isBool) {
        const prev = (base[hk] as BooleanConstraint) ?? {};
        base[hk] = { ...prev, value: typeof patch.value === "boolean" ? patch.value : prev.value };
      } else {
        const prev = (base[hk] as CategoricalConstraint) ?? {};
        base[hk] = { 
          ...prev, 
          includes: typeof patch.includes === 'string' ? patch.includes : prev.includes, 
          exact: typeof patch.exact === 'boolean' ? patch.exact : prev.exact 
        };
      }
    }
  }

  function initializeFromData(headers: string[], rows: Row[], cfg: AppConfig | null) {
    if (!headers.length) return;

    // Logging: column inference snapshot
    try {
      console.groupCollapsed("[Init] Column inference snapshot");
      const boolCols = headers.filter((h) => isBooleanColumn(rows, h));
      const numCols = headers.filter((h) => isNumericColumn(rows, h));
      const catCols = headers.filter((h) => !boolCols.includes(h) && !numCols.includes(h));
      console.log("visible headers", visibleHeaders);
      console.log("boolean columns", boolCols);
      console.log("numeric columns", numCols);
      console.log("categorical columns", catCols);
      console.table(summarizeBooleanCounts(rows, boolCols));
      console.groupEnd();
    } catch {}

    // Build constraints for all VISIBLE columns (not ignored);
    // the panel and filtering will only use constraintHeaders subset.
    const base: Record<string, Constraint> = {};
    for (const h of headers) {
      if (!visibleHeaders.includes(h)) continue;
      base[h] = buildDefaultConstraintForKey(h, rows);
    }
    applyConstraintOverrides(base, headers, rows, cfg);
    setConstraints(base);

    const defaultSelCandidates = (cfg?.tradeoffs?.selected ?? FALLBACK_DEFAULT_TRADEOFFS)
      .map((k) => resolveKey(k, headers, cfg))
      .filter((x): x is string => !!x)
      .filter((k) => visibleHeaders.includes(k))
      .filter((k) => isNumericColumn(rows, k));
    const uniqueSelected = Array.from(new Set(defaultSelCandidates));
    setSelectedTradeoffs(uniqueSelected);

    const defaultWeight = cfg?.tradeoffs?.defaults?.weight ?? 1;
    const defaultDir = cfg?.tradeoffs?.defaults?.direction ?? "lower";
    const trade: Record<string, Tradeoff> = {};
    for (const k of uniqueSelected) trade[k] = { key: k, weight: defaultWeight, direction: defaultDir };

    const tover = cfg?.tradeoffs?.overrides ?? {};
    for (const k of Object.keys(tover)) {
      const hk = resolveKey(k, headers, cfg);
      if (!hk || !uniqueSelected.includes(hk)) continue;
      const patch = tover[k];
      trade[hk] = { ...trade[hk], weight: patch.weight ?? trade[hk].weight, direction: (patch.direction as Tradeoff["direction"]) ?? trade[hk].direction };
    }
    setTradeoffs(trade);

    // Apply constraints only for the chosen constraintHeaders subset
    try {
      console.groupCollapsed("[Before Filter] Constraint summary");
      const summary = constraintHeaders.map((h) => ({
        key: h,
        type: isNumericColumn(rows, h) ? "numeric" : isBooleanColumn(rows, h) ? "boolean" : "categorical",
        constraint: constraints[h] ?? base[h],
      }));
      console.table(summary);
      const boolCounts = summarizeBooleanCounts(rows, constraintHeaders.filter((h) => isBooleanColumn(rows, h)));
      if (boolCounts.length) console.table(boolCounts);
      console.groupEnd();
    } catch {}

    const fr = applyConstraints(rows, base, constraintHeaders);
    setFilteredRows(fr);
    const sr = computeScores(fr, Object.values(trade), nameColumn);
    setScoredRows(sr);

    const feats = makeFeatures(
      // use *visible* columns; booleans treated as categorical in the tree
      visibleHeaders.filter((h) => isNumericColumn(fr, h)),
      visibleHeaders.filter((h) => isBooleanColumn(fr, h)),
      visibleHeaders.filter((h) => !isNumericColumn(fr, h) && !isBooleanColumn(fr, h))
    );
    setTree(fr.length ? buildDecisionTree(sr, feats, { maxDepth: 5, minSamplesSplit: 3, minSamplesLeaf: 2, idPrefix: "dt" }) : null);

  }

  const onFile = async (f: File | null) => {
    if (!f) return;
    const text = await f.text();
    const parsed = parseCSV(text);
    setCsvHeaders(parsed.headers);
    setRawRows(parsed.rows);
    setTimeout(() => initializeFromData(parsed.headers, parsed.rows, config), 0);
  };

  const onConfigFile = async (f: File | null) => {
    if (!f) return;
    try {
      const txt = await f.text();
      const cfg = JSON.parse(txt) as AppConfig;
      setConfig(cfg);
      if (csvHeaders.length && rawRows.length) initializeFromData(csvHeaders, rawRows, cfg);
    } catch (e) {
      console.error("Invalid config JSON", e);
      alert("Invalid config JSON");
    }
  };

  const onApplyConstraints = () => {
    try {
      console.groupCollapsed("[Apply] Constraint summary before filtering");
      const summary = constraintHeaders.map((h) => ({ key: h, constraint: constraints[h] }));
      console.table(summary);
      const boolCounts = summarizeBooleanCounts(rawRows, constraintHeaders.filter((h) => isBooleanColumn(rawRows, h)));
      if (boolCounts.length) console.table(boolCounts);
      console.groupEnd();
    } catch {}
    const fr = applyConstraints(rawRows, constraints, constraintHeaders);

    if (fr.length === 0) {
      try {
        const reasons: Record<string, number> = {};
        const sample = rawRows.slice(0, Math.min(200, rawRows.length));
        for (const r of sample) {
          const key = firstFailingKey(r, constraints, constraintHeaders) ?? "(none)";
          reasons[key] = (reasons[key] ?? 0) + 1;
        }
        console.groupCollapsed("[Apply] Filter resulted in 0 rows — diagnostics");
        console.log("First failing key counts (sample)");
        console.table(Object.entries(reasons).map(([key, count]) => ({ key, count })));
        console.log("Per-column failure breakdown (full set)");
        console.table(analyzeConstraintEffects(rawRows, constraints, constraintHeaders));
        const one = rawRows[0];
        if (one) {
          const obj: Record<string, unknown> = {};
          for (const h of constraintHeaders) obj[h] = one[h];
          console.log("Sample row[0] values for constraint headers", obj);
        }
        console.groupEnd();
      } catch {}
    }
    setFilteredRows(fr);
    const sr = computeScores(fr, Object.values(tradeoffs), nameColumn);
    setScoredRows(sr);
    
    const feats = makeFeatures(
      visibleHeaders.filter((h) => isNumericColumn(fr, h)),
      visibleHeaders.filter((h) => isBooleanColumn(fr, h)),
      visibleHeaders.filter((h) => !isNumericColumn(fr, h) && !isBooleanColumn(fr, h))
    );
    setTree(fr.length ? buildDecisionTree(sr, feats, { maxDepth: 5, minSamplesSplit: 3, minSamplesLeaf: 2, idPrefix: "dt" }) : null);
  };

  React.useEffect(() => {
    if (!filteredRows.length) { setScoredRows([]); setTree(null); return; }
    
    console.log("[Tree Build] Starting tree build with:", {
      filteredRowsLength: filteredRows.length,
      tradeoffsCount: Object.keys(tradeoffs).length,
      visibleHeadersCount: visibleHeaders.length
    });
    
    const sr = computeScores(filteredRows, Object.values(tradeoffs), nameColumn);
    console.log("[Tree Build] Scored rows:", {
      scoredRowsLength: sr.length,
      sampleScores: sr.slice(0, 3).map(r => ({ name: r[nameColumn], score: r.__score }))
    });
    
    setScoredRows(sr);

    const feats = makeFeatures(
      visibleHeaders.filter((h) => isNumericColumn(filteredRows, h)),
      visibleHeaders.filter((h) => isBooleanColumn(filteredRows, h)),
      visibleHeaders.filter((h) => !isNumericColumn(filteredRows, h) && !isBooleanColumn(filteredRows, h))
    );
    
    console.log("[Tree Build] Features:", {
      numericFeatures: feats.filter(f => f.kind === "numeric").map(f => f.name),
      categoricalFeatures: feats.filter(f => f.kind === "categorical").map(f => f.name),
      totalFeatures: feats.length
    });
    
    if (feats.length === 0) {
      console.warn("[Tree Build] No features available for tree building!");
      setTree(null);
      return;
    }
    
    const tree = buildDecisionTree(sr, feats, { maxDepth: 5, minSamplesSplit: 3, minSamplesLeaf: 2, idPrefix: "dt" });
    console.log("[Tree Build] Built tree:", {
      treeKind: tree.kind,
      treeId: tree.id,
      hasLeft: tree.kind === "node" ? !!tree.left : false,
      hasRight: tree.kind === "node" ? !!tree.right : false
    });
    
    setTree(tree);

  }, [filteredRows, tradeoffs, visibleHeaders, nameColumn]);

  // Log the table after applying constraints (whenever filteredRows changes)
  React.useEffect(() => {
    try {
      const rowsToLog = filteredRows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const h of visibleHeaders) out[h] = row[h];
        return out;
      });
      // Collapsed group to avoid noisy console; expand when needed
      console.groupCollapsed("[After Filter] Filtered rows table (%d)", filteredRows.length);
      const boolCounts = summarizeBooleanCounts(filteredRows, visibleHeaders.filter((h) => isBooleanColumn(filteredRows as Row[], h)));
      if (boolCounts.length) {
        console.log("Boolean column counts after filter:");
        console.table(boolCounts);
      }
      console.table(rowsToLog);
      console.groupEnd();
    } catch (e) {
      console.log("[After Filter] Filtered rows (%d)", filteredRows.length, filteredRows);
    }
  }, [filteredRows, visibleHeaders]);
  const exportTree = () => {
    if (!tree) return;
    const blob = new Blob([JSON.stringify(tree, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "decision_tree.json"; a.click(); URL.revokeObjectURL(url);
  };

  const exportConfig = () => {
    const defaultsNumUseRange = config?.constraints?.defaults?.numeric?.useDatasetRange ?? true;
    const defaultNumMin = config?.constraints?.defaults?.numeric?.min ?? null;
    const defaultNumMax = config?.constraints?.defaults?.numeric?.max ?? null;
    const defaultCat = { includes: config?.constraints?.defaults?.categorical?.includes ?? "", exact: config?.constraints?.defaults?.categorical?.exact ?? false };

    const overrides: Record<string, Constraint> = {};
    for (const h of visibleHeaders) {
      const current = constraints[h]; if (!current) continue;
      if (isNumericColumn(rawRows, h)) {
        const mm = getMinMax(rawRows, h) ?? { min: 0, max: 0 };
        const baseline: NumericConstraint = defaultsNumUseRange ? { min: mm.min, max: mm.max } : { min: defaultNumMin ?? undefined, max: defaultNumMax ?? undefined };
        const cur = current as NumericConstraint;
        if (cur.min !== baseline.min || cur.max !== baseline.max) overrides[h] = { min: cur.min, max: cur.max };
      } else if (isBooleanColumn(rawRows, h)) {
        const cur = current as BooleanConstraint;
        if (typeof cur.value === "boolean") overrides[h] = { value: cur.value };
      } else {
        const cur = current as CategoricalConstraint;
        if ((cur.includes ?? "") !== defaultCat.includes || (cur.exact ?? false) !== defaultCat.exact) overrides[h] = { includes: cur.includes ?? "", exact: cur.exact ?? false };
      }
    }

    const tover: Record<string, Partial<Pick<Tradeoff, "weight" | "direction">>> = {};
    const defaultWeight = config?.tradeoffs?.defaults?.weight ?? 1;
    const defaultDir = config?.tradeoffs?.defaults?.direction ?? "lower";
    for (const k of selectedTradeoffs) {
      const t = tradeoffs[k]; if (!t) continue;
      if (t.weight !== defaultWeight || t.direction !== defaultDir) tover[k] = { weight: t.weight, direction: t.direction };
    }

    const out: AppConfig = {
      ignoredColumns: config?.ignoredColumns ?? [],
      columnAliases: config?.columnAliases ?? undefined,
      constraints: {
        includeColumns: config?.constraints?.includeColumns ?? undefined,
        excludeColumns: config?.constraints?.excludeColumns ?? undefined,
        defaults: { numeric: { useDatasetRange: defaultsNumUseRange, min: defaultNumMin, max: defaultNumMax }, categorical: defaultCat },
        overrides,
      },
      tradeoffs: { selected: selectedTradeoffs, defaults: { weight: defaultWeight, direction: defaultDir }, overrides: tover },
    };

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "device_decision_config.json"; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Device Decision Explorer</h1>
          <div className="flex flex-wrap items-center gap-3">
            <label className="px-3 py-2 rounded-xl bg-neutral-800 border border-neutral-700 cursor-pointer hover:bg-neutral-700">
              <input type="file" accept=".csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
              Load CSV
            </label>
            <label className="px-3 py-2 rounded-xl bg-neutral-800 border border-neutral-700 cursor-pointer hover:bg-neutral-700">
              <input type="file" accept=".json" className="hidden" onChange={(e) => onConfigFile(e.target.files?.[0] ?? null)} />
              Load Config JSON
            </label>
            <button onClick={exportConfig} className="px-3 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:bg-neutral-700">
              Export Current Config
            </button>
            <button onClick={exportTree} className="px-3 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-40" disabled={!tree}>
              Export Tree JSON
            </button>
          </div>
        </header>

        {visibleHeaders.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <ConfigBadge config={config} />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <ConstraintsPanel
              headers={constraintHeaders}
              numericColumns={numericColumns.filter((h) => constraintHeaders.includes(h))}
              booleanColumns={booleanColumns.filter((h) => constraintHeaders.includes(h))}
              categoricalColumns={categoricalColumns.filter((h) => constraintHeaders.includes(h))}
              constraints={constraints}
              rawRows={rawRows}
              onChange={setConstraints}
              onApply={onApplyConstraints}
            /> 
              <WeightsPanel
                numericColumns={numericColumns} // tradeoffs unaffected by constraint subset
                selectedTradeoffs={selectedTradeoffs}
                setSelectedTradeoffs={setSelectedTradeoffs}
                tradeoffs={tradeoffs}
                setTradeoffs={setTradeoffs}
              />

              <SummaryPanel nameColumn={nameColumn} filteredRows={filteredRows} scoredRows={scoredRows} />
            </div>


            <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-4">
              <h2 className="text-lg font-medium mb-2">Balanced Decision Tree</h2>

              {!tree ? (
                <p className="text-neutral-400">No rows after filtering.</p>
              ) : (
                <div className="h-[720px] rounded-xl overflow-hidden">
                  <DecisionTreeViz
                    key={`viz-${filteredRows.length}-${scoredRows.length}-${selectedTradeoffs.join("|")}`}
                    balancedTree={tree ? toAppTree(tree) : (null as any)}
                    nameColumn={nameColumn}
                    style={{ height: "100%" }}
                  />
                </div>
              )}
            </section>
          </>
        )}
      </div>
      <div className="mt-6">
</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-300">
      <p className="mb-2">Load your <code>bundles_with_needs_and_tradeoffs.csv</code> and (optionally) a <code>device_decision_config.json</code>.</p>
      <p className="text-sm text-neutral-400">Use <code>constraints.includeColumns</code> to pick a limited set of constraint columns; tradeoffs remain available for all numeric columns.</p>
    </div>
  );
}

function ConfigBadge({ config }: { config: AppConfig | null }) {
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="px-2 py-1 rounded-md border border-neutral-800 bg-neutral-900">Config: {config ? "loaded" : "none"}</span>
      {config?.constraints?.includeColumns && (
        <span className="px-2 py-1 rounded-md border border-neutral-800 bg-neutral-900">Constraints: only [{config.constraints.includeColumns.join(", ")}]</span>
      )}
      {config?.constraints?.excludeColumns && !config?.constraints?.includeColumns && (
        <span className="px-2 py-1 rounded-md border border-neutral-800 bg-neutral-900">Constraints exclude: [{config.constraints.excludeColumns.join(", ")}]</span>
      )}
      {config?.ignoredColumns && config.ignoredColumns.length > 0 && (
        <span className="px-2 py-1 rounded-md border border-neutral-800 bg-neutral-900">Ignored (global): {config.ignoredColumns.join(", ")}</span>
      )}
    </div>
  );
}

// ----------------------------- Panels ------------------------------ //

type ConstraintsPanelProps = {
  headers: string[];
  numericColumns: string[];
  booleanColumns: string[];
  categoricalColumns: string[];
  constraints: Record<string, Constraint>;
  rawRows: Row[];
  onChange: (c: Record<string, Constraint>) => void;
  onApply: () => void;
};

function ConstraintsPanel({ headers, numericColumns, booleanColumns, categoricalColumns, constraints, rawRows, onChange, onApply }: ConstraintsPanelProps) {
  const updateNumeric = (key: string, patch: Partial<NumericConstraint>) => {
    onChange({ ...constraints, [key]: { ...(constraints[key] as NumericConstraint), ...patch } });
  };
  const updateCategorical = (key: string, patch: Partial<CategoricalConstraint>) => {
    onChange({ ...constraints, [key]: { ...(constraints[key] as CategoricalConstraint), ...patch } });
  };
  const updateBoolean = (key: string, patch: Partial<BooleanConstraint>) => {
    const next = { ...constraints, [key]: { ...(constraints[key] as BooleanConstraint), ...patch } };
    try {
      console.groupCollapsed("[UI] Boolean constraint change");
      console.log("key", key);
      console.log("patch", patch);
      console.log("next[key]", next[key]);
      const sampleCounts = summarizeBooleanCounts(rawRows, [key]);
      console.table(sampleCounts);
      console.groupEnd();
    } catch {}
    onChange(next);
  };

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Hard Constraints</h2>
        <button onClick={onApply} className="px-3 py-2 rounded-xl bg-neutral-800 border border-neutral-700 hover:bg-neutral-700">Apply Constraints & Rebuild</button>
      </div>

      <div className="space-y-3 max-h-[520px] overflow-auto pr-2">
        {headers.map((h) => (
          <div key={h} className="rounded-xl border border-neutral-800 p-3">
            <div className="text-sm font-medium mb-2">{h}</div>
            {numericColumns.includes(h) ? (
              <div className="grid grid-cols-2 gap-2">
                <NumericRangeEditor keyName={h} rows={rawRows} constraint={constraints[h] as NumericConstraint} onChange={(patch) => updateNumeric(h, patch)} />
              </div>
            ) : booleanColumns.includes(h) ? (
              <div className="grid grid-cols-1 gap-2">
                <BooleanConstraintEditor keyName={h} constraint={constraints[h] as BooleanConstraint} onChange={(patch) => updateBoolean(h, patch)} />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                <input
                  value={(constraints[h] as CategoricalConstraint)?.includes ?? ""}
                  onChange={(e) => updateCategorical(h, { includes: e.target.value })}
                  placeholder="includes (comma-separated)"
                  className="w-full px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-sm"
                />
                <label className="flex items-center gap-2 text-xs text-neutral-400">
                  <input type="checkbox" checked={(constraints[h] as CategoricalConstraint)?.exact ?? false} onChange={(e) => updateCategorical(h, { exact: e.target.checked })} />
                  exact matches only
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

type NumericRangeEditorProps = { keyName: string; rows: Row[]; constraint: NumericConstraint | undefined; onChange: (patch: Partial<NumericConstraint>) => void };

function NumericRangeEditor({ keyName, rows, constraint, onChange }: NumericRangeEditorProps) {
  const mm = getMinMax(rows, keyName);
  const minVal = constraint?.min ?? mm?.min ?? 0;
  const maxVal = constraint?.max ?? mm?.max ?? 0;
  return (
    <>
      <div className="flex items-center gap-2">
        <label className="text-xs text-neutral-400 w-16">min</label>
        <input type="number" value={Number(minVal)} onChange={(e) => onChange({ min: e.target.value === "" ? undefined : Number(e.target.value) })} className="w-full px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-sm" />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-neutral-400 w-16">max</label>
        <input type="number" value={Number(maxVal)} onChange={(e) => onChange({ max: e.target.value === "" ? undefined : Number(e.target.value) })} className="w-full px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-sm" />
      </div>
    </>
  );
}

type BooleanConstraintEditorProps = { keyName: string; constraint: BooleanConstraint | undefined; onChange: (patch: Partial<BooleanConstraint>) => void };

function BooleanConstraintEditor({ keyName, constraint, onChange }: BooleanConstraintEditorProps) {
  const val = typeof constraint?.value === "boolean" ? (constraint!.value ? "true" : "false") : "";
  return (
    <>
      <label className="text-xs text-neutral-400">value</label>
      <select
        value={val}
        onChange={(e) => onChange({ value: e.target.value === "" ? undefined : e.target.value === "true" })}
        className="w-full px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-sm"
      >
        <option value="">Any</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    </>
  );
}

// ----------------------------- Weights ------------------------------ //

type WeightsPanelProps = { numericColumns: string[]; selectedTradeoffs: string[]; setSelectedTradeoffs: (keys: string[]) => void; tradeoffs: Record<string, Tradeoff>; setTradeoffs: (t: Record<string, Tradeoff>) => void };

function WeightsPanel({ numericColumns, selectedTradeoffs, setSelectedTradeoffs, tradeoffs, setTradeoffs }: WeightsPanelProps) {
  const toggleKey = (k: string, checked: boolean) => {
    const next = checked ? Array.from(new Set([...selectedTradeoffs, k])) : selectedTradeoffs.filter((x) => x !== k);
    setSelectedTradeoffs(next);
    const updated: Record<string, Tradeoff> = { ...tradeoffs };
    if (checked && !updated[k]) updated[k] = { key: k, weight: 1, direction: "higher" };
    if (!checked) delete updated[k];
    setTradeoffs(updated);
  };
  const updateTrade = (k: string, patch: Partial<Tradeoff>) => setTradeoffs({ ...tradeoffs, [k]: { ...tradeoffs[k], ...patch } });
  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-4 space-y-4">
      <h2 className="text-lg font-medium">Tradeoff Weights & Direction</h2>
      <div className="space-y-2">
        <div className="text-sm text-neutral-400">Choose numeric columns to include in the optimizer:</div>
        <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto pr-2">
          {numericColumns.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selectedTradeoffs.includes(k)} onChange={(e) => toggleKey(k, e.target.checked)} />
              {k}
            </label>
          ))}
        </div>
      </div>
      {selectedTradeoffs.length === 0 ? (
        <p className="text-neutral-400 text-sm">Select at least one tradeoff to compute scores.</p>
      ) : (
        <div className="space-y-3 max-h-[360px] overflow-auto pr-2">
          {selectedTradeoffs.map((k) => (
            <div key={k} className="rounded-xl border border-neutral-800 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium text-sm">{k}</div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-neutral-400">weight</label>
                  <input type="number" min={0} step={0.1} value={tradeoffs[k]?.weight ?? 1} onChange={(e) => updateTrade(k, { weight: Math.max(0, Number(e.target.value)) })} className="w-24 px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-sm" />
                  <select value={tradeoffs[k]?.direction ?? "higher"} onChange={(e) => updateTrade(k, { direction: e.target.value as Tradeoff["direction"] })} className="px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-sm">
                    <option value="higher">higher is better</option>
                    <option value="lower">lower is better</option>
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ----------------------------- Summary Panel ------------------------------ //

type SummaryPanelProps = { nameColumn: string; filteredRows: Row[]; scoredRows: Array<Row & { __score: number; __contribs: Contribution[] }> };

function SummaryPanel({ nameColumn, filteredRows, scoredRows }: SummaryPanelProps) {
  const best = useMemo(() => {
    if (!scoredRows.length) return null;
    const sorted = [...scoredRows].sort((a, b) => b.__score - a.__score);
    return sorted[0];
  }, [scoredRows]);
  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-4 space-y-3">
      <h2 className="text-lg font-medium">Summary</h2>
      <div className="text-sm text-neutral-400">Filtered Rows: {filteredRows.length}</div>
      {best ? (
        <div className="text-sm">
          <div className="text-neutral-300">Top Option</div>
          <div className="font-medium">{String(best[nameColumn] ?? "(unnamed)")}</div>
          <div className="text-xs text-neutral-400">score: {best.__score.toFixed(3)}</div>
        </div>
      ) : (
        <div className="text-sm text-neutral-400">No rows scored yet.</div>
      )}
    </section>
  );
}

// ----------------------------- Tree View ------------------------------ //

type TreeViewProps = { node: TreeNode; nameColumn: string };
function TreeView({ node, nameColumn }: TreeViewProps) {
  return (
    <div className="overflow-auto">
      <TreeNodeView node={node} nameColumn={nameColumn} depth={0} />
    </div>
  );
}

type TreeNodeViewProps = { node: TreeNode; nameColumn: string; depth: number };
function TreeNodeView({ node, nameColumn, depth }: TreeNodeViewProps) {
  const [open, setOpen] = useState(false);

  // Leaf
  if (node.kind === "leaf") {
    // sort a few exemplars by score (desc)
    const rows = [...node.rows].sort((a,b) => b.__score - a.__score).slice(0, 5);
    return (
      <div className="ml-4">
        <div className="relative">
          {depth > 0 && <div className="absolute -left-4 top-5 w-4 h-px bg-neutral-700" />}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3 my-2">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium">Leaf • prediction: {node.prediction.toFixed(3)}</div>
                <div className="text-xs text-neutral-400">samples: {node.rows.length}</div>
              </div>
              <button onClick={() => setOpen(o=>!o)} className="px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-xs">
                {open ? "Hide" : "Top examples"}
              </button>
            </div>
            {open && (
              <div className="mt-2 text-xs grid grid-cols-1 md:grid-cols-2 gap-2">
                {rows.map((r, i) => (
                  <div key={i} className="rounded-md border border-neutral-800 p-2">
                    <div className="font-medium truncate">{String(r[nameColumn] ?? "(unnamed)")}</div>
                    <div className="text-neutral-400">score: {r.__score.toFixed(3)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Inner node
  return (
    <div className="ml-4">
      <div className="relative">
        {depth > 0 && <div className="absolute -left-4 top-5 w-4 h-px bg-neutral-700" />}
        <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3 my-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">{node.question}</div>
              <div className="text-xs text-neutral-400">
                {node.stats ? <>n={node.stats.n} • Δvar={node.stats.gain.toFixed(4)}</> : null}
              </div>
            </div>
            <button onClick={() => setOpen(o=>!o)} className="px-2 py-1 rounded-md bg-neutral-800 border border-neutral-700 text-xs">
              {open ? "Hide" : "Split details"}
            </button>
          </div>
          {open && (
            <div className="mt-2 text-xs text-neutral-400 space-y-1">
              <div>feature: <span className="text-neutral-200">{node.feature}</span></div>
              {node.threshold !== undefined && <div>threshold: {Number.isInteger(node.threshold) ? node.threshold : node.threshold.toFixed(3)}</div>}
              {node.category !== undefined && <div>category: "{node.category}"</div>}
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-8">
        <div className="w-px bg-neutral-700 ml-4" />
        <div className="flex-1">
          {node.left && (<div><div className="text-xs text-neutral-500 ml-2">◀ match (≤ threshold or = category)</div><TreeNodeView node={node.left} nameColumn={nameColumn} depth={depth + 1} /></div>)}
          {node.right && (<div><div className="text-xs text-neutral-500 ml-2">no‑match ( &gt; threshold or ≠ category ) ▶</div><TreeNodeView node={node.right} nameColumn={nameColumn} depth={depth + 1} /></div>)}
        </div>
      </div>
    </div>
  );
}

