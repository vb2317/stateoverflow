// app/test-viz/page.tsx (Next.js) or any sandbox component
"use client";
import React from "react";
import DecisionTreeViz, { AppTreeNode } from "@/app/DecisionTreeViz";

const demoTree: AppTreeNode = {
  id: "root",
  row: { name: "mid", __score: 0.5, __contribs: [{ key: "price_inr", value: 100, weight: 1, normalized: 0.5, directedComponent: 0.5, contribution: 0.5 }] },
  left: {
    id: "L",
    row: { name: "left-leaf", __score: 0.2, __contribs: [{ key: "price_inr", value: 80, weight: 1, normalized: 0.2, directedComponent: 0.8, contribution: 0.8 }] },
    left: null,
    right: null,
  },
  right: {
    id: "R",
    row: { name: "right-leaf", __score: 0.9, __contribs: [{ key: "price_inr", value: 140, weight: 1, normalized: 0.9, directedComponent: 0.1, contribution: 0.1 }] },
    left: null,
    right: null,
  },
};

export default function Page() {
  return (
    <div className="h-[760px] p-4 bg-neutral-950">
      <DecisionTreeViz balancedTree={demoTree} nameColumn="name" />
    </div>
  );
}
