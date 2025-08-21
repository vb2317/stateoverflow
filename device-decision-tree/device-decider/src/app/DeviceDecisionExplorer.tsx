"use client";

import React, { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronRight, Undo2, Share2, Download } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// -------------------- Decision Graph --------------------
const NODES: Record<string, any> = {
  start: {
    id: "start",
    type: "question",
    prompt: "What's your budget (₹)?",
    subtitle: "Pick the closest band.",
    options: [
      { id: "price_low", label: "Under 80k", to: "learning_hours" },
      { id: "price_mid", label: "80k – 130k", to: "learning_hours" },
      { id: "price_high", label: "130k – 200k", to: "learning_hours" },
      { id: "price_ultra", label: "200k+", to: "learning_hours" },
    ],
  },

  learning_hours: {
    id: "learning_hours",
    type: "question",
    prompt: "How many hours/week will you invest in learning the new setup?",
    options: [
      { id: "learn_0_5", label: "0–5 hrs/week", to: "maintenance_hours_per_year" },
      { id: "learn_6_10", label: "6–10 hrs/week", to: "maintenance_hours_per_year" },
      { id: "learn_11_20", label: "11–20 hrs/week", to: "maintenance_hours_per_year" },
      { id: "learn_20_plus", label: "20+ hrs/week", to: "maintenance_hours_per_year" },
    ],
  },

  maintenance_hours_per_year: {
    id: "maintenance_hours_per_year",
    type: "question",
    prompt: "How many hours/year do you expect to spend on maintenance?",
    options: [
      { id: "maint_0_10", label: "0–10 hrs/year", to: "power_adequacy_score" },
      { id: "maint_10_30", label: "10–30 hrs/year", to: "power_adequacy_score" },
      { id: "maint_30_100", label: "30–100 hrs/year", to: "power_adequacy_score" },
      { id: "maint_100_plus", label: "100+ hrs/year", to: "power_adequacy_score" },
    ],
  },

  power_adequacy_score: {
    id: "power_adequacy_score",
    type: "question",
    prompt: "How adequate is your current device's power?",
    subtitle: "1 = totally inadequate, 10 = more than enough",
    options: [
      { id: "power_low", label: "1–3 (very low)", to: "mbp_perf" },
      { id: "power_med", label: "4–6 (moderate)", to: "mbp_light_reco" },
      { id: "power_high", label: "7–8 (quite adequate)", to: "mba_reco" },
      { id: "power_excellent", label: "9–10 (excellent)", to: "keep_plus_accessories_reco" },
    ],
  },

  portability: {
    id: "portability",
    type: "question",
    prompt: "Will you run heavy ML/video locally this year?",
    options: [
      { id: "p_ml_yes", label: "Yes — often", to: "mbp_perf" },
      { id: "p_ml_no", label: "No — mostly writing/plots", to: "typing_or_touch" },
    ],
  },

  typing_or_touch: {
    id: "typing_or_touch",
    type: "question",
    prompt: "Day-to-day, what feels more natural?",
    options: [
      { id: "p_type", label: "Typing-first (code/docs)", to: "mba_reco" },
      { id: "p_touch", label: "Touch-first (markups/reading)", to: "ipad_air_reco" },
    ],
  },

  performance: {
    id: "performance",
    type: "question",
    prompt: "Do you need NVIDIA/CUDA locally?",
    subtitle:
      "If yes, Apple laptops won't run CUDA natively; consider a remote Linux box.",
    options: [
      { id: "perf_cuda_yes", label: "Yes — CUDA required", to: "remote_linux_reco" },
      { id: "perf_cuda_no", label: "No — Apple silicon is fine", to: "mbp_perf" },
    ],
  },

  pen: {
    id: "pen",
    type: "question",
    prompt: "Is sketching/handwritten markup central to your workflow?",
    options: [
      { id: "pen_core_yes", label: "Yes — central", to: "ipad_pro_reco" },
      { id: "pen_core_no", label: "Nice-to-have", to: "mba_plus_ipad_reco" },
    ],
  },

  value: {
    id: "value",
    type: "question",
    prompt: "What's your comfortable budget (₹)?",
    subtitle: "Indicative bands to funnel choices.",
    options: [
      { id: "v_low", label: "Under 80k", to: "keep_plus_accessories_reco" },
      { id: "v_mid", label: "80k – 130k", to: "mba_reco" },
      { id: "v_high", label: "130k – 200k", to: "mbp_light_reco" },
      { id: "v_ultra", label: "200k+", to: "mbp_perf" },
    ],
  },

  longevity: {
    id: "longevity",
    type: "question",
    prompt: "Planned ownership horizon?",
    options: [
      { id: "l_short", label: "1–2 years", to: "keep_plus_accessories_reco" },
      { id: "l_med", label: "3–4 years", to: "mba_reco" },
      { id: "l_long", label: "5+ years", to: "mbp_light_reco" },
    ],
  },

  // --- RECOMMENDATIONS ---
  mba_reco: {
    id: "mba_reco",
    type: "recommendation",
    title: "MacBook Air (13″ or 15″)",
    blurb:
      "Light, silent, excellent battery. Ideal for writing, coding light workloads, data viz, and travel.",
    details: [
      "Pair with a 27″ external monitor for home.",
      "Choose 16–24 GB unified memory if you keep many notebooks/tabs.",
      "Great value; resale remains strong.",
    ],
  },

  mbp_light_reco: {
    id: "mbp_light_reco",
    type: "recommendation",
    title: "MacBook Pro (14″) — balanced",
    blurb:
      "Better sustained performance, brighter display, more ports. Good for occasional video/ML without overkill.",
    details: [
      "Consider 32 GB unified memory if you touch large models.",
      "Excellent keyboard/thermals; still portable.",
    ],
  },

  mbp_perf: {
    id: "mbp_perf",
    type: "recommendation",
    title: "MacBook Pro (14″/16″) — performance tier",
    blurb:
      "For sustained compiles, video exports, or on-device ML. Heavier but durable workhorse.",
    details: [
      "Spec RAM generously; storage as needed (use external SSDs for media).",
      "If frequent desk work, add a dock + 4K/5K monitor.",
    ],
  },

  ipad_air_reco: {
    id: "ipad_air_reco",
    type: "recommendation",
    title: "iPad Air + Pencil (+ keyboard)",
    blurb:
      "Great for reading, handwritten notes, and markups. Fine companion to a desktop or existing laptop.",
    details: [
      "Use apps like GoodNotes/Notability for workflows.",
      "Keyboard case helps for travel typing, but not a full laptop replacement for dev work.",
    ],
  },

  ipad_pro_reco: {
    id: "ipad_pro_reco",
    type: "recommendation",
    title: "iPad Pro + Pencil — sketch-first setup",
    blurb:
      "Best pen latency and display for artists, architects, and diagram-heavy thinking.",
    details: [
      "Add a stand and external keyboard for desk sessions.",
      "If coding is primary, consider pairing with a Mac later.",
    ],
  },

  mba_plus_ipad_reco: {
    id: "mba_plus_ipad_reco",
    type: "recommendation",
    title: "MacBook Air + entry iPad (refurb ok)",
    blurb:
      "Typing-first flow with occasional sketching. Versatile without overspending.",
    details: [
      "Sidecar/Universal Control make the combo seamless.",
      "Upgrade iPad later if pen becomes central.",
    ],
  },

  remote_linux_reco: {
    id: "remote_linux_reco",
    type: "recommendation",
    title: "Keep/Buy Mac + remote NVIDIA box",
    blurb:
      "Best of both: Apple reliability for daily use, CUDA GPU on a remote Linux workstation or cloud when needed.",
    details: [
      "Use SSH + VS Code Remote or Jupyter over tailscale.",
      "Scale GPU only when projects demand it; saves weight and cost.",
    ],
  },

  keep_plus_accessories_reco: {
    id: "keep_plus_accessories_reco",
    type: "recommendation",
    title: "Keep current device + targeted accessories",
    blurb:
      "Start writing now. Add a used 4K monitor, external keyboard, and a fast SSD. Reassess in 90 days.",
    details: [
      "The best setup is the one you already have — today.",
      "Measure friction and upgrade the bottleneck, not the ego.",
    ],
  },
};

// -------------------- Helpers --------------------
function getNode(id: string) {
  return NODES[id];
}

function childrenOf(id: string) {
  const node = getNode(id);
  if (!node) return [] as string[];
  if (node.type === "recommendation") return [] as string[];
  return node.options.map((o: any) => o.to) as string[];
}

function buildSubtree(rootId: string, depthCap = 12): any {
  const node = getNode(rootId);
  if (!node || depthCap <= 0) return null;
  const kids = childrenOf(rootId);
  return {
    id: rootId,
    label: node.type === "question" ? node.prompt : getNode(rootId).title,
    kind: node.type,
    children: kids.map((c) => buildSubtree(c, depthCap - 1)).filter(Boolean),
  };
}

function shorten(s?: string, n = 30) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// -------------------- Tree (Top-down, below Q&A) --------------------
function layoutTreeTopDown(tree: any) {
  const layers: any[][] = [];
  function dfs(n: any, depth = 0) {
    if (!n) return;
    if (!layers[depth]) layers[depth] = [];
    layers[depth].push(n);
    n.children?.forEach((c: any) => dfs(c, depth + 1));
  }
  dfs(tree);
  const positions = new Map<string, any>();
  const width = Math.max(320, layers.reduce((m, arr) => Math.max(m, arr.length), 0) * 170);
  const height = Math.max(360, layers.length * 120);
  layers.forEach((nodes, depth) => {
    const gapX = width / (nodes.length + 1);
    nodes.forEach((n, i) => {
      const x = (i + 1) * gapX;
      const y = 40 + depth * ((height - 80) / Math.max(1, layers.length - 1));
      positions.set(n.id, { x, y, ref: n });
    });
  });
  const links: any[] = [];
  layers.forEach((nodes) => {
    nodes.forEach((n) => {
      n.children?.forEach((c: any) => {
        links.push({ from: positions.get(n.id), to: positions.get(c.id) });
      });
    });
  });
  return { width, height, positions, links };
}

function TreeViz({ pathNodeIds }: { pathNodeIds: string[] }) {
  const fullTree = useMemo(() => buildSubtree("start"), []);
  const layout = useMemo(() => (fullTree ? layoutTreeTopDown(fullTree) : null), [fullTree]);
  if (!fullTree || !layout) return null;

  const { width, height, positions, links } = layout;
  const pathSet = new Set(pathNodeIds);

  return (
    <div className="w-full rounded-2xl border p-3">
      <div className="text-sm font-medium mb-2">Decision Tree</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[420px]">
        {links.map((ln, i) => {
          const fromInPath = pathSet.has(ln.from.ref.id);
          const toInPath = pathSet.has(ln.to.ref.id);
          const isPathLink = fromInPath && toInPath;
          return (
            <path
              key={i}
              d={`M ${ln.from.x} ${ln.from.y} C ${ln.from.x} ${(ln.from.y + ln.to.y) / 2}, ${ln.to.x} ${(ln.from.y + ln.to.y) / 2}, ${ln.to.x} ${ln.to.y}`}
              fill="none"
              stroke="currentColor"
              opacity={isPathLink ? 0.9 : 0.25}
              strokeWidth={isPathLink ? 4 : 2}
            />
          );
        })}
        {[...positions.values()].map(({ x, y, ref }) => {
          const isInPath = pathSet.has(ref.id);
          const isQuestion = ref.kind === "question";
          return (
            <g key={ref.id} transform={`translate(${x},${y})`}>
              <circle r={10} className={isInPath ? "fill-current" : ""} />
              <text x={14} y={4} fontSize={10} className="select-none">
                {isQuestion ? "?" : "★"} {shorten(ref.label, 28)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="text-[10px] text-muted-foreground">Bold links & filled nodes = chosen path; ★ = recommendation, ? = question.</div>
    </div>
  );
}

// -------------------- UI bits --------------------
function PathCrumbs({ path }: { path: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {path.map((p, i) => (
        <Badge key={i} variant="secondary" className="text-xs">
          {p}
        </Badge>
      ))}
    </div>
  );
}

function Question({ node, onChoose }: { node: any; onChoose: (opt: any) => void }) {
  return (
    <Card className="border-2">
      <CardContent className="p-6 space-y-4">
        <div>
          <h2 className="text-xl font-semibold">{node.prompt}</h2>
          {node.subtitle && (
            <p className="text-sm text-muted-foreground mt-1">{node.subtitle}</p>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {node.options.map((opt: any) => (
            <Button
              key={opt.id}
              variant="outline"
              className="justify-between"
              onClick={() => onChoose(opt)}
            >
              <span>{opt.label}</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Recommendation({ node, onRestart, onShare, pathLabels }: { node: any; onRestart: () => void; onShare: () => void; pathLabels: string[] }) {
  return (
    <Card className="border-2">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold">Recommendation</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Based on your path: {pathLabels.join(" → ")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onShare}>
              <Share2 className="h-4 w-4 mr-2" /> Share
            </Button>
            <Button variant="outline" onClick={onRestart}>
              <Undo2 className="h-4 w-4 mr-2" /> Restart
            </Button>
          </div>
        </div>
        <div className="p-4 rounded-2xl bg-muted/40">
          <div className="text-lg font-semibold">{node.title}</div>
          <div className="text-sm mt-1">{node.blurb}</div>
          <ul className="list-disc pl-5 mt-3 text-sm space-y-1">
            {node.details?.map((d: string, i: number) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Tip: Export this decision and attach it to your post.
          </div>
          <ExportDecisionButton node={node} pathLabels={pathLabels} />
        </div>
      </CardContent>
    </Card>
  );
}

function ExportDecisionButton({ node, pathLabels }: { node: any; pathLabels: string[] }) {
  const onDownload = () => {
    const payload = {
      timestamp: new Date().toISOString(),
      path: pathLabels,
      recommendation: node.title,
      blurb: node.blurb,
      details: node.details,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "device-decision.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Button variant="outline" onClick={onDownload}>
      <Download className="h-4 w-4 mr-2" /> Export JSON
    </Button>
  );
}

function PathSketch({ steps }: { steps: string[] }) {
  const width = 680;
  const height = 140;
  const padX = 24;
  const colGap = (width - padX * 2) / Math.max(steps.length - 1, 1);
  const yMid = height / 2;

  const points = steps.map((_, i) => [padX + i * colGap, yMid]);
  const pathD = points
    .map((p, i) => (i === 0 ? `M ${p[0]},${p[1]}` : `L ${p[0]},${p[1]}`))
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[140px]">
      <path d={pathD} fill="none" strokeWidth="3" stroke="currentColor" opacity={0.3} />
      {points.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={6} />
      ))}
      {steps.map((s, i) => (
        <text key={i} x={padX + i * colGap} y={yMid - 14} fontSize="10" textAnchor="middle">
          {s}
        </text>
      ))}
    </svg>
  );
}

function NeedsForm({ values, setValues }: { values: any; setValues: (v: any) => void }) {
  const fields = [
    { key: "chip", label: "Chip", type: "text", placeholder: "M3 / M4 / M4 Pro" },
    { key: "ram_gb", label: "RAM (GB)", type: "number", min: 8, max: 128, step: 8 },
    { key: "storage_tb", label: "Storage (TB)", type: "number", min: 0.25, max: 8, step: 0.25 },
    { key: "battery_hours", label: "Battery (hrs)", type: "number", min: 5, max: 30, step: 0.5 },
    { key: "weight_kg", label: "Weight (kg)", type: "number", min: 0.3, max: 3.0, step: 0.01 },
    { key: "display_inches", label: "Display (in)", type: "number", min: 10, max: 32, step: 0.1 },
    { key: "ports", label: "Ports", type: "text", placeholder: "2x TB4, MagSafe, HDMI" },
  ] as const;

  function handleChange(key: string, type: string, raw: string) {
    if (type === "number") {
      const parsed = raw === "" ? "" : Number(raw);
      setValues({ ...values, [key]: isNaN(parsed as number) ? values[key] : parsed });
    } else {
      setValues({ ...values, [key]: raw });
    }
  }

  return (
    <Card className="border-2">
      <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={f.key}>{f.label}</Label>
            <Input
              id={f.key}
              type={f.type}
              placeholder={(f as any).placeholder}
              value={values[f.key]}
              min={(f as any).min}
              max={(f as any).max}
              step={(f as any).step}
              onChange={(e) => handleChange(f.key, f.type, e.target.value)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// -------------------- Page --------------------
export default function DeviceDecisionExplorer() {
  const [stack, setStack] = useState<string[]>(["start"]);
  const [labels, setLabels] = useState<string[]>([]);
  const [needs, setNeeds] = useState<any>({
    chip: "M4",
    ram_gb: 16,
    storage_tb: 1,
    battery_hours: 15,
    weight_kg: 1.3,
    display_inches: 14,
    ports: "2x Thunderbolt 4, MagSafe",
    price_inr: 120000,
    learning_hours: 10,
    maintenance_hours_per_year: 20,
    power_adequacy_score: 7,
  });

  const node = NODES[stack[stack.length - 1]];
  const isResult = node.type === "recommendation";

  const handleChoose = (opt: any) => {
    setStack((s) => [...s, opt.to]);
    setLabels((l) => [...l, opt.label]);
  };

  const handleBack = () => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    setLabels((l) => (l.length > 0 ? l.slice(0, -1) : l));
  };

  const handleRestart = () => {
    setStack(["start"]);
    setLabels([]);
  };

  const handleShare = async () => {
    try {
      await navigator.share?.({
        title: "Device Decision",
        text: labels.join(" → "),
        url: typeof window !== "undefined" ? window.location.href : "",
      });
    } catch (e) {}
  };

  const stepsForSketch = useMemo(() => ["Start", ...labels, isResult ? "Result" : "…"], [labels, isResult]);

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-bold">Paths to Your Next Device</h1>
        <p className="text-muted-foreground text-sm">An interactive, opinionated guide to decide whether you need a new MacBook or iPad — or just a new habit.</p>
        <PathSketch steps={stepsForSketch} />
      </header>

      {/* Needs form */}
      <NeedsForm values={needs} setValues={setNeeds} />

      <div className="flex items-center justify-between">
        <PathCrumbs path={labels.length ? labels : ["Start"]} />
        {stack.length > 1 && (
          <Button variant="outline" onClick={handleBack}>Back</Button>
        )}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={node.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
          {node.type === "question" ? (
            <Question node={node} onChoose={handleChoose} />
          ) : (
            <Recommendation node={node} onRestart={handleRestart} onShare={handleShare} pathLabels={labels} />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Tree BELOW the text, top-down layout */}
      <TreeViz pathNodeIds={stack} />

      <footer className="text-xs text-muted-foreground">Built for the State Overflow blog. Includes editable needs form at top.</footer>
    </div>
  );
}
