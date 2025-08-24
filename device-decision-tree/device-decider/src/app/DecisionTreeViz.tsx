'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';

/** ----------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------- */
type BulletType = 'pro' | 'con' | 'note' | 'price';

type Option = {
  kind: 'option';
  id: string;
  name: string; // Leaf label (device/bundle name)
  bullets: { text: string; type: BulletType }[];
};

type Decision = {
  kind: 'decision';
  id: string;
  question: string; // Non-leaf (question text)
  children: Array<{ label: string; child: Decision | Option }>; // edge label + child
};

type TreeNode = Decision | Option;

// Accept the balanced tree from DeviceDecisionApp without changing its shape
export type AppContribution = {
  key: string;
  value: number;
  normalized: number;
  weight: number;
  directedComponent: number;
  contribution: number;
};

export type AppScoredRow = Record<string, any> & {
  __score: number;
  __contribs: AppContribution[];
};

export type AppTreeNode = {
  id: string;
  row: Record<string, any> & { __score: number; __contribs: any[] };
  left: AppTreeNode | null;
  right: AppTreeNode | null;
};

type DecisionTreeVizProps = {
  data?: Decision;
  initialSelectedLeafId?: string;
  style?: React.CSSProperties;
  balancedTree?: AppTreeNode | null;
  nameColumn?: string;
};

function friendlyQuestion(metricKey?: string): string {
  switch(metricKey) {
    case 'price_inr': return 'Price?';
    case 'battery_hours_min': return 'Battery?';
    case 'carry_weight_kg': return 'Weight?';
    case 'power_adequacy_score': return 'Performance?';
    case 'display_inches': return 'Screen Size?';
    case 'learning_hours_sum': return 'Setup Effort?';
    case 'maintenance_hours_per_year_sum': return 'Maitenance Effort?';
    default: return 'Overall Best?';
  }
}

// Colors
const chosen = '#2dd4bf';   // teal
const muted  = '#64748b';   // slate
const fg     = '#e5e7eb';
const bg     = '#0b1220';
const card   = '#0e1626';
const stroke = '#94a3b8';

// ── Add near the top ─────────────────────────────────────────────
const FRIENDLY_LABELS: Record<string, { label: string; unit?: string; higherIs?: 'better'|'worse' }> = {
  price_inr:              { label: 'Price', unit: '₹', higherIs: 'worse' },
  battery_hours_min:      { label: 'Battery life', unit: 'h', higherIs: 'better' },
  carry_weight_kg:        { label: 'Weight', unit: 'kg', higherIs: 'worse' },
  power_adequacy_score:   { label: 'Performance score', higherIs: 'better' },
  display_inches:         { label: 'Screen size', 'unit': '″', higherIs: 'better' },
  learning_hours_sum:     { label: 'Learning curve', unit: 'h', higherIs: 'worse' },
  maintenance_hours_per_year_sum: { label: 'Yearly upkeep', unit: 'h', higherIs: 'worse' },
};


function humanMetric(key?: string) {
  if (!key) return { question: 'Best overall fit', left: 'lower', right: 'higher' };
  const m = FRIENDLY_LABELS[key];
  if (!m) return { question: key, left: 'lower', right: 'higher' };
  const q = `Which ${m.label} fits better?`;
  // friendlier edge labels
  const left  = m.higherIs === 'better' ? `less ${m.label}` : `less ${m.label} (good)`;
  const right = m.higherIs === 'better' ? `more ${m.label}` : `more ${m.label} (costlier)`;
  return { question: q, left, right };
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 999,
      border: '1px solid #334155',
      fontSize: 11,
      lineHeight: '16px',
      marginRight: 6
    }}>{children}</span>
  );
}

// ── Add: tiny tooltip helper ─────────────────────────────────────
function WhyTip({ text }: { text: string }) {
  return (
    <span
      title={text}
      style={{ borderBottom: '1px dotted #94a3b8', cursor: 'help', marginLeft: 6, fontSize: 11, color: '#94a3b8' }}
    >
      Why?
    </span>
  );
}

// Find the most relevant tradeoff on a row (same idea as in your App)
function mostRelevantTradeoffApp(contribs: AppContribution[]): AppContribution | null {
  if (!contribs || !contribs.length) return null;
  return contribs.reduce((best, c) =>
    Math.abs(c.contribution) > Math.abs(best.contribution) ? c : best
  );
}

function topKey(n: AppTreeNode | null): string | undefined {
  if (!n) return undefined;
  const top = mostRelevantTradeoffApp((n.row.__contribs || []) as AppContribution[]);
  return top?.key?.trim() || undefined;
}

/**
 * Adapter: convert the balanced binary tree (AppTreeNode) into Decision/Option Tree.
 * - Internal nodes → Decision (diamond) with question = most relevant tradeoff key (fallback: "Score split")
 * - Left edge label  → "lower scores"
 * - Right edge label → "higher scores"
 * - Leaf → Option card with name + a couple bullets (score + top tradeoff)
 */
export function adaptBalancedTreeToViz(
  node: AppTreeNode,
  opts: { nameColumn: string; leafBulletCount?: number } = { nameColumn: "name", leafBulletCount: 2 }
): Decision {
  const { nameColumn, leafBulletCount = 2 } = opts;
  
  function toDecisionOrOption(n: AppTreeNode): Decision | Option {
    const isLeaf = !n.left && !n.right;
    if (isLeaf) {
      const name = String(n.row[nameColumn] ?? "(unnamed)");

      // Build minimal bullets: score + most-relevant tradeoff
      const top = mostRelevantTradeoffApp(n.row.__contribs || []) || null;
      const bullets: Option['bullets'] = [
        { text: `overall fit: ${Number(n.row.__score).toFixed(2)}`, type: 'note' },
      ];

      if (top) {
        const m = FRIENDLY_LABELS[top.key];
        const pretty = m ? m.label : top.key;
        const valStr = Number.isFinite(top.value) ? ` = ${top.value}` : '';
        bullets.push({ text: `most influenced by: ${pretty}${valStr}`, type: 'pro' });
      }
      // If desired, add a third bullet by peeking second-best; keeping minimal for step 1
      const option: Option = {
        kind: 'option',
        id: n.id,
        name,
        bullets: bullets.slice(0, leafBulletCount),
      } as Option;
      (option as any).row = n.row;
      return option;

    }

    const rel = mostRelevantTradeoffApp(n.row.__contribs || []);
      const metric =
        (rel?.key && String(rel.key).trim()) ||
        topKey(n.left) ||
        topKey(n.right) ||
        Object.keys(n.row).find(
          (k) => k !== "__score" && !k.startsWith("__") && typeof n.row[k] === "number"
        ) ||
        "";

      // then keep your existing labels:
      const question  = metric ? friendlyQuestion(metric) : "Best overall fit";
      const left = metric ? `less ${metric}` : "lower scores";
      const right = metric ? `more ${metric}` : "higher scores";
    //const { question, left, right } = humanMetric(metricKey || undefined);

    const children: Decision['children'] = [];
    if (n.left)  children.push({ label: left,  child: toDecisionOrOption(n.left)  });
    if (n.right) children.push({ label: right, child: toDecisionOrOption(n.right) });


    return { kind: 'decision', id: n.id, question, children };
  }

  // Wrap the converted node under a synthetic root if needed (optional). Here we convert the root itself.
  const converted = toDecisionOrOption(node);
  if (converted.kind === "decision") return converted;

  // If the input happens to be a single leaf, create a tiny root
  const root = {
    kind: "decision" as const,
    id: "root",
    question: "Top result",
    children: [{ label: "", child: converted }],
  };

  return root;
}

/** ----------------------------------------------------------------
 * Sample data (replace with your tree)
 * ---------------------------------------------------------------- */
const sampleTree: Decision = {
  kind: 'decision',
  id: 'root',
  question: 'MacBook?',
  children: [
    {
      label: 'Air — 15" M4',
      child: {
        kind: 'option',
        id: 'air15m4',
        name: 'MacBook Air 15″ (M4)',
        bullets: [
          { text: 'Stylish, light', type: 'pro' },
          { text: 'Bigger display', type: 'pro' },
          { text: 'May throttle under load', type: 'con' },
          { text: '4–6 years life', type: 'note' },
          { text: '₹2,05,000', type: 'price' },
        ],
      },
    },
    {
      label: 'Pro — 14" M4',
      child: {
        kind: 'option',
        id: 'pro14m4',
        name: 'MacBook Pro 14″ (M4)',
        bullets: [
          { text: 'Active cooling', type: 'pro' },
          { text: 'HDR mini-LED', type: 'pro' },
          { text: 'More ports', type: 'pro' },
          { text: '6–8 years life', type: 'pro' },
          { text: '₹2,29,900', type: 'price' },
        ],
      },
    },
  ],
};

/** ----------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------- */
function isOption(n: TreeNode): n is Option {
  return n.kind === 'option';
}
function isDecision(n: TreeNode): n is Decision {
  return n.kind === 'decision';
}

function buildHierarchy(root: Decision) {
  const edgeLabel = new Map<string, string>();

  const d3Root = d3.hierarchy<TreeNode>(root, (n) =>
    isDecision(n) ? n.children.map((c) => c.child) : null
  );

  function fill(n: Decision) {
    for (const c of n.children) {
      edgeLabel.set(`${n.id}->${(c.child as any).id}`, c.label);
      if (isDecision(c.child)) fill(c.child);
    }
  }
  fill(root);

  return { d3Root, edgeLabel };
}

function collectPathIds(root: Decision, toLeafId?: string) {
  const path = new Set<string>();
  if (!toLeafId) return path;
  const target = String(toLeafId);

  function dfs(node: TreeNode, stack: string[]): boolean {
    if (isOption(node)) {
      if (String(node.id) === target) {
        for (const id of [...stack, String(node.id)]) path.add(id);
        return true;
      }
      return false;
    }
    let found = false;
    for (const { child } of node.children) {
      if (dfs(child, [...stack, String(node.id)])) found = true;
    }
    return found;
  }

  dfs(root, []);
  return path;
}

function edgeKey(
  a: d3.HierarchyPointNode<TreeNode>,
  b: d3.HierarchyPointNode<TreeNode>
) {
  return `${String((a.data as any).id)}->${String((b.data as any).id)}`;
}

function iconFor(type: BulletType) {
  switch (type) {
    case 'pro':
      return '✅';
    case 'con':
      return '❌';
    case 'note':
      return '⚠️';
    case 'price':
      return '💰';
  }
}

/** ----------------------------------------------------------------
 * Resize hook
 * ---------------------------------------------------------------- */
function useContainerSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 800, height: 640 });

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = e.contentRect;
        setSize({ width: r.width, height: r.height });
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  return { ref, ...size } as const;
}

function collectChosenEdges(root: Decision, toLeafId?: string) {
  const edges = new Set<string>();
  if (!toLeafId) return edges;

  function walk(n: TreeNode): boolean {
    if (isOption(n)) return String(n.id) === String(toLeafId);
    let used = false;
    for (const { child } of n.children) {
      if (walk(child)) {
        edges.add(`${String((n as Decision).id)}->${String((child as any).id)}`);
        used = true;
      }
    }
    return used;
  }
  walk(root);
  return edges;
}

/** ----------------------------------------------------------------
 * Component (TOP-DOWN layout)
 * ---------------------------------------------------------------- */
export default function DecisionTreeViz({
  data: fallbackData = sampleTree,
  initialSelectedLeafId = 'pro14m4',
  style,
  balancedTree,
  nameColumn = "name",
}: DecisionTreeVizProps) {
  const [selectedLeafId, setSelectedLeafId] = useState<string | undefined>(
    initialSelectedLeafId
  );
  const { ref, width, height } = useContainerSize<HTMLDivElement>();

  // Visual constants
  const leafW = 280;
  const leafH = 164;
  const leafR = 18;

  const qW = 200; // diamond width
  const qH = 110; // diamond height

  // Spacing tuned for cards: nodeSize([horizontal spacing, vertical spacing])
  // Horizontal spacing should be >= leafW + side margins to prevent overlap.
  const H_SPACING = leafW + 120; // siblings distance
  const V_SPACING = 240;         // parent→child distance


  const effectiveData: Decision = useMemo(() => {
    console.log("[DecisionTreeViz] effectiveData calculation:", {
      hasBalancedTree: !!balancedTree,
      balancedTreeId: balancedTree?.id,
      nameColumn,
      fallbackDataId: fallbackData.id
    });
    
    if (balancedTree) {
      try {
        const result = adaptBalancedTreeToViz(balancedTree, { nameColumn, leafBulletCount: 2 });
        console.log("[DecisionTreeViz] Successfully adapted tree:", {
          resultId: result.id,
          resultKind: result.kind,
          childrenCount: result.kind === "decision" ? result.children.length : 0
        });
        return result;
      } catch (e) {
        console.warn("[DecisionTreeViz] adaptBalancedTreeToViz failed; falling back", e);
        return fallbackData;
      }
    }
    console.log("[DecisionTreeViz] Using fallback data");
    return fallbackData;
  }, [balancedTree, fallbackData, nameColumn]); 

  const { nodes, links, edgeLabel, contentSize } = useMemo(() => {
    const { d3Root, edgeLabel } = buildHierarchy(effectiveData);

    const treeLayout = d3
      .tree<TreeNode>()
      .nodeSize([H_SPACING, V_SPACING]) // top-down: x=left/right, y=depth
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.2));

    const laid = treeLayout(d3Root);
    const nodes = laid.descendants();
    const links = laid.links();

    const xMin = d3.min(nodes, (d) => d.x) ?? 0;
    const xMax = d3.max(nodes, (d) => d.x) ?? 0;
    const yMin = d3.min(nodes, (d) => d.y) ?? 0;
    const yMax = d3.max(nodes, (d) => d.y) ?? 0;

    const padding = { top: 100, right: 160, bottom: 120, left: 160 };
    const contentSize = {
      width: xMax - xMin + padding.left + padding.right,
      height: yMax - yMin + padding.top + padding.bottom,
      xOffset: -xMin + padding.left,
      yOffset: -yMin + padding.top,
    };

    // Bake offsets into node positions for a single pan/zoom group
    nodes.forEach((n) => {
      (n as any)._x = n.x + contentSize.xOffset;
      (n as any)._y = n.y + contentSize.yOffset;
    });

    return { nodes, links, edgeLabel, contentSize };
  }, [effectiveData]);

  const chosenEdgeKeys = useMemo(
    () => collectChosenEdges(effectiveData, selectedLeafId),
    [effectiveData, selectedLeafId]
  );

  console.log({
  selectedLeafId: String(selectedLeafId),
  chosenEdgesCount: chosenEdgeKeys.size,
  sampleEdge: links[0] ? edgeKey(links[0].source as any, links[0].target as any) : null
});

  const chosenPathIds = useMemo(
    () => collectPathIds(effectiveData, selectedLeafId),
    [effectiveData, selectedLeafId]
  );

// Build breadcrumb from chosenPathIds
const breadcrumb = useMemo(() => {
  if (!selectedLeafId) return [];
  const labels: string[] = [];
  // Walk links on path and collect edge labels
  links.forEach(lk => {
    const ekey = edgeKey(lk.source as any, lk.target as any); // already "a->b"
    const onChosenPath = chosenEdgeKeys.has(ekey);
    const s = (lk.source.data as any).id;
    const t = (lk.target.data as any).id;
    if (chosenPathIds.has(s) && chosenPathIds.has(t)) {
      const lbl = edgeLabel.get(edgeKey(lk.source as any, lk.target as any));
      if (lbl) labels.push(lbl);
    }
  });
  const leafName = nodes.find(n => (n.data as any).id === selectedLeafId)?.data as any;
  if (leafName?.name) labels.push(leafName.name);
  return labels;
}, [selectedLeafId, links, chosenPathIds, edgeLabel, nodes]);


  // D3 zoom/pan (no React state → no rerender loop)
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomGroupRef = useRef<SVGGElement | null>(null);
  const zoomBehavior = useRef<d3.ZoomBehavior<Element, unknown> | null>(null);
  const zoomReadyRef = useRef(false);

  useEffect(() => {
    if (!svgRef.current || !zoomGroupRef.current) return;

    const svgSel = d3.select(svgRef.current);
    const groupSel = d3.select(zoomGroupRef.current);

    const z = d3
      .zoom<Element, unknown>()
      .scaleExtent([0.5, 2.5])
      .on('zoom', (ev) => {
        groupSel.attr('transform', ev.transform.toString());
      });

    svgSel.call(z as any);
    zoomBehavior.current = z;
    zoomReadyRef.current = true;

    return () => {
      svgSel.on('.zoom', null);
    };
  }, []);

  function fitToScreen() {
    if (!svgRef.current || !zoomBehavior.current) return;

    const viewW = width;
    const viewH = height;
    const contentW = contentSize.width;
    const contentH = contentSize.height;

    const scale = Math.min(viewW / contentW, viewH / contentH, 1.2);
    const tx = (viewW - contentW * scale) / 2;
    const ty = (viewH - contentH * scale) / 2;

    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    const svgSel = d3.select(svgRef.current);
    (svgSel as any).transition().duration(300).call(zoomBehavior.current!.transform, t);
  }

  useEffect(() => {
    if (!zoomReadyRef.current) return;
    fitToScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, contentSize.width, contentSize.height]);

  // Vertical (top-down) link generator
  const linkPath = d3
    .linkVertical<{ source: any; target: any }, any>()
    .x((d: any) => d.x)
    .y((d: any) => d.y);

  // Colors
  const green = '#22c55e';
  const red = '#ef4444';
  const fg = '#e5e7eb';
  const bg = '#0b1220';
  const card = '#0e1626';
  const stroke = '#cbd5e1';

  return (
    <div
      ref={ref}
      style={{
        width: '100%',
        height: 680,
        borderRadius: 16,
        border: '1px solid #1f2937',
        overflow: 'hidden',
        position: 'relative',
        background: bg,
        ...style,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          color: '#e5e7eb',
          background: 'rgba(0,0,0,0.2)',
          backdropFilter: 'blur(6px)',
          zIndex: 2,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontWeight: 600, letterSpacing: -0.2 }}>Decision Tree</span>
          <span style={{ color: '#94a3b8', fontSize: 12 }}>Click a leaf to choose</span>
{/*breadcrumb.length > 0 && (
  <div style={{
    position: 'absolute', top: 48, left: 12, right: 12,
    color: '#94a3b8', fontSize: 12
  }}>
    <span aria-label="Decision path">{breadcrumb.join('  →  ')}</span>
  </div>
)*/}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => {
              setSelectedLeafId(undefined)}
            }
            style={{
              padding: '6px 10px',
              fontSize: 12,
              borderRadius: 10,
              color: '#e5e7eb',
              background: '#111827',
              border: '1px solid #374151',
            }}
          >
            Clear choice
          </button>
          <button
            onClick={fitToScreen}
            style={{
              padding: '6px 10px',
              fontSize: 12,
              borderRadius: 10,
              color: '#e5e7eb',
              background: '#111827',
              border: '1px solid #374151',
            }}
          >
            Fit to screen
          </button>
        </div>
      </div>

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        role="img"
        aria-label="Interactive decision tree"
      >
<defs>
      <marker
        id="arrow-chosen"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill={chosen} />
      </marker>
      <marker
        id="arrow-muted"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill={muted} />
      </marker>
    </defs>
        {/* Single pan/zoom group */}
        <g ref={zoomGroupRef}>
          {/* Background for better panning feel */}
          <rect width={contentSize.width} height={contentSize.height} fill={bg} />

          {/* Links */}
          <g>
           {links.map((lk, i) => {
  const s = { x: (lk.source as any)._x, y: (lk.source as any)._y };
  const t = { x: (lk.target as any)._x, y: (lk.target as any)._y };
  const d = linkPath({ source: s, target: t }) as string;

  const ekey = edgeKey(lk.source as any, lk.target as any);
  const onChosenPath = chosenEdgeKeys.has(ekey);

  const color = onChosenPath ? chosen /* was green */ : muted /* was red */;

  // Edge label (slightly above mid)
  const midX = (s.x + t.x) / 2;
  const midY = (s.y + t.y) / 2 - 12;
  const label = edgeLabel.get(ekey);

  return (
    <g key={i}>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={onChosenPath ? 3 : 2}
        strokeDasharray={onChosenPath ? undefined : '4 6'}
        markerEnd={`url(#arrow-${onChosenPath ? 'chosen' : 'muted'})`}
      />
      {label && (
        <g transform={`translate(${midX},${midY})`}>
          <rect
            x={-64}
            y={-14}
            width={128}
            height={24}
            rx={8}
            ry={8}
            fill={bg}
            stroke={color}
            strokeWidth={1.5}
          />
          <text
            x={0}
            y={0}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={12}
            fill={color}
            style={{ fontFamily: 'ui-rounded, ui-sans-serif, system-ui' }}
          >
            {label}
          </text>
        </g>
      )}
    </g>
  );
})}
 
          </g>

          {/* Nodes */}
          <g>
            {nodes.map((nd, i) => {
              const isLeaf = isOption(nd.data);
              const id = String((nd.data as any).id);
              const onPath = chosenPathIds.has(id);
              const border = onPath ? chosen : muted;

              const x = (nd as any)._x;
              const y = (nd as any)._y;

              if (!isLeaf) {
                const q = nd.data as Decision;
                return (
                  <g key={i} transform={`translate(${x},${y})`} style={{ transition: 'transform 250ms ease, opacity 250ms ease', opacity: onPath ? 1 : 0.85 }}>
                    {/* Diamond (question) */}
                    <path
                      d={`M 0 ${-qH / 2} L ${qW / 2} 0 L 0 ${qH / 2} L ${-qW / 2} 0 Z`}
                      fill={bg}
                      stroke={stroke}
                      strokeWidth={2.5}
                    />
                    <text
                      x={0}
                      y={0}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={14}
                      fill={fg}
                      style={{
                        fontWeight: 700,
                        fontFamily: 'ui-rounded, ui-sans-serif, system-ui',
                      }}
                    >
                      {q.question}
                    </text>
                  </g>
                );
              }
              const leaf = nd.data as Option;
              return (

                <g
                  key={i}
                  transform={`translate(${x},${y})`}
                  style={{ transition: 'transform 250ms ease, opacity 250ms ease', opacity: onPath ? 1 : 0.85 }}
                  onClick={(e) => { e.stopPropagation(); setSelectedLeafId(leaf.id); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedLeafId(leaf.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Choose ${leaf.name}`}
                >
                  {/* Leaf card background */}
                  <rect
                    x={-leafW / 2}
                    y={-leafH / 2}
                    width={leafW}
                    height={leafH}
                    rx={leafR}
                    ry={leafR}
                    fill={card}
                    stroke={border}
                    strokeWidth={2.5}
                  />
              

                  {/* text content inside foreignObject so it can wrap */}
                  <foreignObject
                    x={-leafW / 2 + 10}
                    y={-leafH / 2 + 10}
                    width={leafW - 20}
                    height={leafH - 20}
                  >
                    
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        fontSize: "13px",
                        color: "#e5e7eb",
                        fontFamily: "ui-rounded, ui-sans-serif, system-ui",
                        overflow: "hidden",
                        wordWrap: "break-word",
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
  {leaf.name}
  {/* Why? tooltip synthesizing top tradeoff */}
  {leaf.bullets[1] && <WhyTip text={leaf.bullets[1].text} />}
</div>
<div style={{ marginBottom: 6 }}>
  {'price_inr' in leaf && null /* silences TS if not present */}
  <Badge>💰 {Intl.NumberFormat('en-IN').format((leaf as any).row?.price_inr ?? leafW /* fallback removed */)}</Badge>
  {((leaf as any).row?.battery_hours_min) && <Badge>🔋 {(leaf as any).row.battery_hours_min}h</Badge>}
  {((leaf as any).row?.carry_weight_kg) && <Badge>⚖️ {(leaf as any).row.carry_weight_kg}kg</Badge>}
</div>
                      {leaf.bullets.slice(0, 4).map((b, idx) => (
                        <div key={idx} style={{ fontSize: "12px", marginBottom: 2 }}>
                          {iconFor(b.type)}{" "}
                          <span style={{ color: b.type === "con" ? "#fca5a5" : "#e5e7eb" }}>
                            {b.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </g>
          <rect
      x={-leafW / 2}
      y={-leafH / 2}
      width={leafW}
      height={leafH}
      rx={leafR}
      ry={leafR}
      fill="black"
      fillOpacity={0.001}
      pointerEvents="visiblePainted"
    />
        </g>
      </svg>

      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          right: 12,
          bottom: 10,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          color: '#cbd5e1',
          fontSize: 12,
          background: 'rgba(0,0,0,0.3)',
          padding: '6px 10px',
          borderRadius: 999,
          border: '1px solid #334155',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 2, background: '#22c55e', borderRadius: 2 }} />
          Chosen path
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 2, background: '#ef4444', borderRadius: 2 }} />
          Other paths
        </span>
      </div>
    </div>
  );
}
