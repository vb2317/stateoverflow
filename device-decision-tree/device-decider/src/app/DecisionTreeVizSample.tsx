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

  function dfs(node: TreeNode, stack: string[]): boolean {
    if (isOption(node)) {
      if (node.id === toLeafId) {
        for (const id of [...stack, node.id]) path.add(id);
        return true;
      }
      return false;
    }
    let found = false;
    for (const { child } of node.children) {
      if (dfs(child, [...stack, node.id])) found = true;
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
  return `${(a.data as any).id}->${(b.data as any).id}`;
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

/** ----------------------------------------------------------------
 * Component (TOP-DOWN layout)
 * ---------------------------------------------------------------- */
export default function DecisionTreeViz({
  data = sampleTree,
  initialSelectedLeafId = 'pro14m4',
  style,
}: {
  data?: Decision;
  initialSelectedLeafId?: string;
  style?: React.CSSProperties;
}) {
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

  const { nodes, links, edgeLabel, contentSize } = useMemo(() => {
    const { d3Root, edgeLabel } = buildHierarchy(data);

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
  }, [data]);

  const chosenPathIds = useMemo(
    () => collectPathIds(data, selectedLeafId),
    [data, selectedLeafId]
  );

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
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setSelectedLeafId(undefined)}
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
            id="arrow-green"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={green} />
          </marker>
          <marker
            id="arrow-red"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={red} />
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

              const sourceId = (lk.source.data as any).id as string;
              const targetId = (lk.target.data as any).id as string;
              const onChosenPath =
                chosenPathIds.has(sourceId) && chosenPathIds.has(targetId);
              const color = onChosenPath ? green : red;

              // Edge label (slightly above mid)
              const midX = (s.x + t.x) / 2;
              const midY = (s.y + t.y) / 2 - 12;
              const label = edgeLabel.get(edgeKey(lk.source as any, lk.target as any));

              return (
                <g key={i}>
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth={3}
                    markerEnd={`url(#arrow-${onChosenPath ? 'green' : 'red'})`}
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
              const id = (nd.data as any).id as string;
              const onPath = chosenPathIds.has(id);
              const border = onPath ? green : red;
              const x = (nd as any)._x;
              const y = (nd as any)._y;

              if (!isLeaf) {
                const q = nd.data as Decision;
                return (
                  <g key={i} transform={`translate(${x},${y})`}>
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
                <g key={i} transform={`translate(${x},${y})`}>
                  {/* Leaf card */}
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
                  {/* Click target */}
                  <rect
                    x={-leafW / 2}
                    y={-leafH / 2}
                    width={leafW}
                    height={leafH}
                    rx={leafR}
                    ry={leafR}
                    fill="transparent"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedLeafId(leaf.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedLeafId(leaf.id);
                      }
                    }}
                    tabIndex={0}
                  />
                  {/* Title */}
                  <text
                    x={-leafW / 2 + 14}
                    y={-leafH / 2 + 26}
                    fontSize={14}
                    fill={fg}
                    style={{
                      fontWeight: 700,
                      fontFamily: 'ui-rounded, ui-sans-serif, system-ui',
                    }}
                  >
                    {leaf.name}
                  </text>
                  {/* Bullets */}
                  <g transform={`translate(${-leafW / 2 + 14}, ${-leafH / 2 + 46})`}>
                    {leaf.bullets.slice(0, 6).map((b, idx) => (
                      <g key={idx} transform={`translate(0, ${idx * 20})`}>
                        <text x={0} y={0} fontSize={13} fill={fg}>
                          {iconFor(b.type)}{' '}
                          <tspan fill={b.type === 'con' ? '#fca5a5' : fg}>
                            {b.text}
                          </tspan>
                        </text>
                      </g>
                    ))}
                  </g>
                </g>
              );
            })}
          </g>
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
