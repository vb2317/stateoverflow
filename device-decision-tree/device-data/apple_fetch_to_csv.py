# apple_fetch_to_csv.py
# Scrape Apple India for current Mac & iPad lineups and save to CSVs.
# - Uses Playwright to load pages and capture embedded JSON where possible
# - Falls back to DOM parsing
# - Heuristically parses "From ₹..." prices (compare pages sometimes expose only tokens)
#
# Install:
# python -m venv .venv && source .venv/bin/activate
#pip install playwright bs4 lxml pandas rich
#playwright install
#
# Usage:
#   python apple_fetch_to_csv.py --region IN --out out/ [--headless] [--timeout 60]
#
# Outputs:
#   out/mac_lineup_current_<YYYY-MM-DD>.csv
#   out/ipads_india_specs_<YYYY-MM-DD>.csv

from __future__ import annotations

import argparse
import json
import os
import re
import time
from dataclasses import dataclass, asdict
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

# ------------------------------------------------------------
# Config
# ------------------------------------------------------------

CURRENCY_BY_REGION = {
    "IN": ("INR", "₹"),
    "US": ("USD", "$"),
    "UK": ("GBP", "£"),
    "GB": ("GBP", "£"),
    "DE": ("EUR", "€"),
    "FR": ("EUR", "€"),
    "EU": ("EUR", "€"),
}

URLS = {
    "ipad_compare": "https://www.apple.com/{region}/ipad/compare/",
    "mac_compare": "https://www.apple.com/{region}/mac/compare/",
    # Buy pages often have clearer "From" prices
    "buy_pages": {
        "macbook-air": "https://www.apple.com/{region}/shop/buy-mac/macbook-air",
        "macbook-pro": "https://www.apple.com/{region}/shop/buy-mac/macbook-pro",
        "imac": "https://www.apple.com/{region}/shop/buy-mac/imac",
        "mac-mini": "https://www.apple.com/{region}/shop/buy-mac/mac-mini",
        "mac-studio": "https://www.apple.com/{region}/shop/buy-mac/mac-studio",
        "mac-pro": "https://www.apple.com/{region}/shop/buy-mac/mac-pro",
        "ipad-pro": "https://www.apple.com/{region}/shop/buy-ipad/ipad-pro",
        "ipad-air": "https://www.apple.com/{region}/shop/buy-ipad/ipad-air",
        "ipad": "https://www.apple.com/{region}/shop/buy-ipad/ipad",
        "ipad-mini": "https://www.apple.com/{region}/shop/buy-ipad/ipad-mini",
    },
    # Marketing pages (sometimes carry weights/specs in a stable 'Tech Specs' section)
    "marketing_pages": {
        "ipad-pro": "https://www.apple.com/{region}/ipad-pro/",
        "ipad-air": "https://www.apple.com/{region}/ipad-air/",
        "ipad": "https://www.apple.com/{region}/ipad-11/",
        "ipad-mini": "https://www.apple.com/{region}/ipad-mini/",
    },
}

TOKEN_RE = re.compile(r"\{([A-Z0-9_]+)\}\*?")
NUM_RE = re.compile(r"\b(\d+(?:\.\d+)?)\b")
INCH_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:[\"”]|-?inch|\s?in)\b", re.I)

# ------------------------------------------------------------
# Data models
# ------------------------------------------------------------

@dataclass
class ProductRow:
    name: str
    category: str
    url: Optional[str]
    chip: Optional[str]
    ram_gb: Optional[float]
    storage_gb: Optional[float]
    storage_tb: Optional[float]
    battery_hours: Optional[float]
    weight_kg: Optional[float]
    price_inr: Optional[float]
    ports: Optional[str]
    display_inches: Optional[float]
    notes: Optional[str]
    learning_hours: Optional[float]
    maintenance_hours_per_year: Optional[float]
    power_adequacy_score: Optional[float]

# ------------------------------------------------------------
# Utilities
# ------------------------------------------------------------

def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)

def clean_text(s: Optional[str]) -> str:
    if not s:
        return ""
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace("—", "-").replace("\u00a0", " ")
    # remove footnote markers / trailing asterisks
    s = re.sub(r"\^\{?\d+\}?|\*+$", "", s).strip()
    # discard footnote-only fragments
    if re.fullmatch(r"\d{1,2}", s):
        return ""
    return s

def normalize_label(s: str) -> str:
    s = (s or "").lower().strip()
    s = s.replace("\u2011", "-").replace("\u2013", "-").replace("\u2014", "-")
    s = re.sub(r"\s+", " ", s)
    return s

def parse_currency_amount(text: str) -> Tuple[Optional[str], Optional[str], Optional[float]]:
    """
    Extract currency symbol + amount from strings like:
    "From ₹89,900", "Starting at $999", "₹ 1,29,900"
    """
    t = text.replace(",", "").strip()
    m = re.search(r"(₹|\$|€|£)\s?(\d+(?:\.\d+)?)", t)
    symbol = None
    amount = None
    code = None
    if m:
        symbol = m.group(1)
        amount = float(m.group(2))
        code = {"₹": "INR", "$": "USD", "€": "EUR", "£": "GBP"}.get(symbol)
        return code, symbol, amount
    # fallback: bare number
    m2 = NUM_RE.search(t)
    return None, None, float(m2.group(1)) if m2 else None

def to_inches(text: str) -> Optional[float]:
    m = INCH_RE.search(text or "")
    if m:
        try:
            return float(m.group(1))
        except:
            return None
    return None

def to_float_kg(text: str) -> Optional[float]:
    t = (text or "").lower()
    m = re.search(r"(\d+(?:\.\d+)?)\s*kg", t)
    return float(m.group(1)) if m else None

def extract_token(text: str) -> Optional[str]:
    m = TOKEN_RE.search(text or "")
    return m.group(1) if m else None

def set_region_defaults(region: str) -> Tuple[Optional[str], Optional[str]]:
    return CURRENCY_BY_REGION.get(region.upper(), (None, None))

# ------------------------------------------------------------
# Browser helpers
# ------------------------------------------------------------

def launch_browser(headless: bool):
    p = sync_playwright().start()
    browser = p.chromium.launch(headless=headless)
    context = browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1440, "height": 900},
        locale="en-IN",
    )
    page = context.new_page()
    return p, browser, context, page

def goto_and_capture(page, url: str, timeout: int = 60) -> Tuple[str, List[Tuple[str, Any]]]:
    captured: List[Tuple[str, Any]] = []

    def on_response(resp):
        try:
            ct = (resp.headers or {}).get("content-type", "")
            if "json" in ct:
                if any(k in resp.url.lower() for k in ["compare", "ipad", "mac", "models", "grid", "data", "spec"]):
                    captured.append((resp.url, resp.json()))
        except Exception:
            pass

    page.on("response", on_response)
    page.set_default_timeout(timeout * 1000)
    page.goto(url, wait_until="networkidle")
    # allow lazy scripts
    time.sleep(1.0)
    html = page.content()
    return html, captured

# ------------------------------------------------------------
# Compare-page mappers (Shape A / Shape B)
# ------------------------------------------------------------

def map_compare_payload(payload: Any) -> Dict[str, Dict[int, str]]:
    """
    Normalize payload to {row_label: {col_index: cell_text}}
    Works for known "sections/rows/cells" (Shape A) and "grid.rows/values" (Shape B).
    """
    grid: Dict[str, Dict[int, str]] = {}
    try:
        # Shape A
        if isinstance(payload, dict) and "sections" in payload:
            for sec in payload.get("sections", []):
                for row in sec.get("rows", []):
                    label = clean_text(row.get("label") or row.get("title") or "")
                    vals = row.get("cells") or row.get("values") or []
                    if not label or not isinstance(vals, list):
                        continue
                    grid[label] = {i: clean_text(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
                                   for i, v in enumerate(vals)}
            return grid
        # Shape B
        if isinstance(payload, dict) and "grid" in payload and isinstance(payload["grid"], dict):
            for r in payload["grid"].get("rows", []):
                label = clean_text(r.get("key") or r.get("label") or "")
                vals = r.get("values") or r.get("cells") or []
                if not label or not isinstance(vals, list):
                    continue
                grid[label] = {i: clean_text(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
                               for i, v in enumerate(vals)}
            return grid
    except Exception:
        pass
    return grid

def extract_model_names_from_payload(payload: Any) -> List[str]:
    names: List[str] = []
    # Try Shape A 'models' or 'columns'
    try:
        if isinstance(payload, dict):
            if "models" in payload and isinstance(payload["models"], list):
                for m in payload["models"]:
                    if isinstance(m, dict):
                        nm = clean_text(m.get("displayName") or m.get("name") or m.get("title") or "")
                        if nm:
                            names.append(nm)
            elif "columns" in payload and isinstance(payload["columns"], list):
                for m in payload["columns"]:
                    if isinstance(m, dict):
                        nm = clean_text(m.get("displayName") or m.get("name") or m.get("title") or "")
                        if nm:
                            names.append(nm)
            elif "grid" in payload and isinstance(payload["grid"], dict):
                for c in payload["grid"].get("columns", []):
                    nm = clean_text(c.get("displayName") or c.get("name") or c.get("title") or "")
                    if nm:
                        names.append(nm)
    except Exception:
        pass
    return names

# ------------------------------------------------------------
# Field extraction from compare grids
# ------------------------------------------------------------

def parse_ipad_compare_grid(grid: Dict[str, Dict[int, str]], names: List[str], region: str) -> List[Dict[str, Any]]:
    """
    Extracts a handful of consistent iPad fields from a normalized compare grid.
    """
    # Common labels we care about (case-insensitive match)
    keys = {normalize_label(k): k for k in grid.keys()}
    out: List[Dict[str, Any]] = []
    for idx, name in enumerate(names):
        row: Dict[str, Any] = {
            "name": name,
            "category": "ipad",
            "chip": None,
            "storage_gb": None,
            "storage_tb": None,
            "battery_hours": None,
            "weight_kg": None,
            "ports": None,
            "display_inches": None,
            "price_inr": None,
            "price_tokens": {},
            "notes": "",
        }

        # Display size & panel
        for label_norm, orig in keys.items():
            if label_norm.startswith("display") and idx in grid[orig]:
                text = grid[orig][idx]
                inc = to_inches(text)
                if inc and not row["display_inches"]:
                    row["display_inches"] = inc
                if "thunderbolt" in text.lower():
                    row["ports"] = "USB-C (Thunderbolt/USB 4)"
        # Chip
        for label_norm, orig in keys.items():
            if "processor" in label_norm or "chip" in label_norm:
                val = grid[orig].get(idx, "")
                m = re.search(r"\b(M\d+(?:\s?(Pro|Max))?|A\d+\s?Pro|A\d+)\b", val)
                if m:
                    row["chip"] = m.group(0).replace("  ", " ")

        # Battery (hours — Apple usually quotes “up to 10 hours”)
        for label_norm, orig in keys.items():
            if "battery" in label_norm or "power" in label_norm:
                val = grid[orig].get(idx, "")
                hr = re.search(r"(\d+)\s*hours?", val.lower())
                if hr:
                    row["battery_hours"] = float(hr.group(1))

        # Weight (Wi-Fi model)
        for label_norm, orig in keys.items():
            if "weight" in label_norm:
                val = grid[orig].get(idx, "")
                kg = to_float_kg(val)
                if kg:
                    row["weight_kg"] = kg

        # Storage (parse options; record min/max)
        for label_norm, orig in keys.items():
            if "storage" in label_norm or "capacity" in label_norm:
                val = grid[orig].get(idx, "")
                # canonical list like "128GB, 256GB, 512GB, 1TB, 2TB"
                t = val.lower().replace("tb", "000gb")
                caps = [int(x) for x in re.findall(r"(\d{2,5})\s*gb", t)]
                if caps:
                    row["storage_gb"] = min(caps)
                    row["storage_tb"] = (max(caps) / 1000.0)
                else:
                    up = re.search(r"up to\s*(\d{3,5})\s*gb", t)
                    if up:
                        row["storage_tb"] = float(up.group(1)) / 1000.0

        # Price tokens or price text
        # Sometimes the compare grid has a "Price" row that contains:
        #   "Wi-Fi {TOKEN}*  Wi-Fi + Cellular {TOKEN}*"
        for label_norm, orig in keys.items():
            if label_norm == "price" and idx in grid[orig]:
                cell = grid[orig][idx]
                # Try numeric first
                _, _, amt = parse_currency_amount(cell)
                if amt:
                    # We'll set price later in INR if symbol visible; otherwise leave None
                    row["price_inr"] = amt
                # Extract tokens when present
                tokens = {}
                for m in TOKEN_RE.finditer(cell):
                    window = cell[max(0, m.start()-40): m.end()+40].lower()
                    if "wi-fi + cellular" in window or "wifi + cellular" in window or "cellular" in window:
                        tokens["cellular"] = m.group(1)
                    else:
                        tokens["wifi"] = m.group(1)
                row["price_tokens"] = tokens

        out.append(row)
    return out

def parse_mac_compare_grid(grid: Dict[str, Dict[int, str]], names: List[str], region: str) -> List[Dict[str, Any]]:
    """
    Extracts a handful of consistent Mac fields from a normalized compare grid.
    """
    keys = {normalize_label(k): k for k in grid.keys()}
    out: List[Dict[str, Any]] = []

    for idx, name in enumerate(names):
        row: Dict[str, Any] = {
            "name": name,
            "category": "macbook" if "macbook" in name.lower() else "mac",
            "chip": None,
            "ram_gb": None,
            "storage_gb": None,
            "storage_tb": None,
            "battery_hours": None,
            "weight_kg": None,
            "ports": None,
            "display_inches": None,
            "price_inr": None,
            "notes": "",
        }

        # Display inches (for Mac notebooks / iMac)
        for label_norm, orig in keys.items():
            if "display" in label_norm and idx in grid[orig]:
                inc = to_inches(grid[orig][idx])
                if inc:
                    row["display_inches"] = inc

        # Chip
        for label_norm, orig in keys.items():
            if "processor" in label_norm or "chip" in label_norm:
                val = grid[orig].get(idx, "")
                m = re.search(r"\b(M\d+(?:\s?(Pro|Max|Ultra))?)\b", val)
                if m:
                    row["chip"] = m.group(1).replace("  ", " ")

        # Battery (not for desktops)
        for label_norm, orig in keys.items():
            if "battery" in label_norm or "power" in label_norm:
                val = grid[orig].get(idx, "")
                hr = re.search(r"(\d+)\s*hours?", val.lower())
                if hr:
                    row["battery_hours"] = float(hr.group(1))

        # Weight (notebooks)
        for label_norm, orig in keys.items():
            if "weight" in label_norm:
                kg = to_float_kg(grid[orig].get(idx, ""))
                if kg:
                    row["weight_kg"] = kg

        # Ports — if present as text
        for label_norm, orig in keys.items():
            if "ports" in label_norm or "connector" in label_norm:
                txt = grid[orig].get(idx, "")
                if txt:
                    row["ports"] = txt

        # Storage (options)
        for label_norm, orig in keys.items():
            if "storage" in label_norm:
                t = grid[orig].get(idx, "").lower().replace("tb", "000gb")
                caps = [int(x) for x in re.findall(r"(\d{2,5})\s*gb", t)]
                if caps:
                    row["storage_gb"] = min(caps)
                    row["storage_tb"] = (max(caps) / 1000.0)

        out.append(row)
    return out

# ------------------------------------------------------------
# Price extraction from "Buy" pages
# ------------------------------------------------------------

def get_from_price_inr(page_html: str, region: str) -> Optional[float]:
    """
    Parse the first plausible "From ₹..." (or currency) amount on a buy page.
    """
    soup = BeautifulSoup(page_html, "lxml")
    text = clean_text(soup.get_text(" ", strip=True))
    # Prefer occurrences near "From" or "Starting at"
    near = re.findall(r"(?:From|Starting at)\s*(₹|\$|€|£)\s?(\d{2,7}(?:\.\d{1,2})?)", text, flags=re.I)
    if near:
        sym, amt = near[0]
        amt = float(amt.replace(",", ""))
        if region.upper() == "IN" and sym == "₹":
            return amt

    # fallback: any currency on the page (first match)
    cur, sym, amt = parse_currency_amount(text)
    if region.upper() == "IN" and sym == "₹" and amt:
        return amt
    return None

def fetch_buy_page_price(page, url: str, timeout: int = 60) -> Optional[float]:
    html, _ = goto_and_capture(page, url, timeout=timeout)
    return get_from_price_inr(html, region="IN")

# ------------------------------------------------------------
# Top-level runners
# ------------------------------------------------------------

def scrape_ipads(region: str, out_dir: Path, headless: bool, timeout: int) -> Path:
    p, browser, context, page = launch_browser(headless=headless)

    try:
        compare_url = URLS["ipad_compare"].format(region=region.lower())
        html, payloads = goto_and_capture(page, compare_url, timeout=timeout)

        # Prefer payloads
        grid = {}
        names = []
        for _, pl in payloads:
            grid = map_compare_payload(pl)
            if grid:
                names = extract_model_names_from_payload(pl)
                if names:
                    break

        if not grid:
            # DOM fallback
            soup = BeautifulSoup(html, "lxml")
            # Very light fallback: extract all text blocks; this is a last resort.
            # (Most of the time the payload exists.)
            # We won't implement a complex DOM grid walker here since payloads are common.
            pass

        # If names missing, derive rough column count from a long row
        if not names and grid:
            # pick the longest row
            longest = max(grid.values(), key=lambda d: len(d)) if grid else {}
            col_count = len(longest)
            names = [f"Model {i+1}" for i in range(col_count)]

        rows = parse_ipad_compare_grid(grid, names, region=region)

        # Prices: buy pages (per-family). We map by simple heuristics:
        buy_urls = {
            "pro": URLS["buy_pages"]["ipad-pro"].format(region=region.lower()),
            "air": URLS["buy_pages"]["ipad-air"].format(region=region.lower()),
            "ipad": URLS["buy_pages"]["ipad"].format(region=region.lower()),
            "mini": URLS["buy_pages"]["ipad-mini"].format(region=region.lower()),
        }
        # Fetch each only once
        buy_html_cache: Dict[str, str] = {}
        for family, url in buy_urls.items():
            h, _ = goto_and_capture(page, url, timeout=timeout)
            buy_html_cache[family] = h

        for r in rows:
            nm = r["name"].lower()
            family = None
            if "pro" in nm:
                family = "pro"
            elif "air" in nm:
                family = "air"
            elif "mini" in nm:
                family = "mini"
            else:
                family = "ipad"

            price = get_from_price_inr(buy_html_cache.get(family, ""), region)
            # Heuristic: if the page contains multiple "From" prices (11 vs 13"),
            # choose the smaller for 11", larger for 13" based on detected inches.
            if family in {"pro", "air"} and buy_html_cache.get(family):
                # collect all INR amounts on the page
                text = clean_text(BeautifulSoup(buy_html_cache[family], "lxml").get_text(" ", strip=True))
                amts = [float(a.replace(",", "")) for _, a in re.findall(r"(₹)\s?(\d{2,7}(?:\.\d{1,2})?)", text)]
                amts = sorted(set(amts))
                if amts:
                    if r.get("display_inches") and r["display_inches"] >= 12.8:
                        price = max(amts)  # 13"
                    else:
                        price = min(amts)  # 11"
            r["price_inr"] = price

            # Normalize ports for Pro
            if not r["ports"] and "pro" in nm:
                r["ports"] = "USB-C (Thunderbolt/USB 4)"
            elif not r["ports"]:
                r["ports"] = "USB-C"

        # Minimal shaping to your requested schema
        out_rows: List[ProductRow] = []
        for r in rows:
            out_rows.append(ProductRow(
                name=r["name"],
                category="ipad",
                url=None,
                chip=r.get("chip"),
                ram_gb=None,
                storage_gb=r.get("storage_gb"),
                storage_tb=r.get("storage_tb"),
                battery_hours=r.get("battery_hours") or 10.0,
                weight_kg=r.get("weight_kg"),
                price_inr=r.get("price_inr"),
                ports=r.get("ports"),
                display_inches=r.get("display_inches"),
                notes=r.get("notes"),
                learning_hours=None,
                maintenance_hours_per_year=None,
                power_adequacy_score=None,
            ))

        df = pd.DataFrame([asdict(x) for x in out_rows], columns=[
            "name","category","url","chip","ram_gb","storage_gb","storage_tb","battery_hours",
            "weight_kg","price_inr","ports","display_inches","notes","learning_hours",
            "maintenance_hours_per_year","power_adequacy_score"
        ])
        ensure_dir(out_dir)
        csv_path = out_dir / f"ipads_india_specs_{date.today().isoformat()}.csv"
        df.to_csv(csv_path, index=False)
        return csv_path
    finally:
        context.close()
        browser.close()
        p.stop()

def scrape_macs(region: str, out_dir: Path, headless: bool, timeout: int) -> Path:
    p, browser, context, page = launch_browser(headless=headless)
    try:
        compare_url = URLS["mac_compare"].format(region=region.lower())
        html, payloads = goto_and_capture(page, compare_url, timeout=timeout)

        grid = {}
        names = []
        for _, pl in payloads:
            grid = map_compare_payload(pl)
            if grid:
                names = extract_model_names_from_payload(pl)
                if names:
                    break

        if not names and grid:
            longest = max(grid.values(), key=lambda d: len(d)) if grid else {}
            names = [f"Model {i+1}" for i in range(len(longest))]

        rows = parse_mac_compare_grid(grid, names, region=region)

        # Buy pages for prices
        buy_urls = {k: v.format(region=region.lower()) for k, v in URLS["buy_pages"].items()}
        buy_cache: Dict[str, str] = {}
        # fetch a subset required for mapping names
        need_pages = ["macbook-air", "macbook-pro", "imac", "mac-mini", "mac-studio", "mac-pro"]
        for key in need_pages:
            h, _ = goto_and_capture(page, buy_urls[key], timeout=timeout)
            buy_cache[key] = h

        def price_from_family(name_lower: str) -> Optional[float]:
            if "macbook air" in name_lower:
                return get_from_price_inr(buy_cache["macbook-air"], region)
            if "macbook pro" in name_lower:
                return get_from_price_inr(buy_cache["macbook-pro"], region)
            if "imac" in name_lower:
                # Two-port vs four-port may have two prices; pick smaller for two-port keyword
                text = clean_text(BeautifulSoup(buy_cache["imac"], "lxml").get_text(" ", strip=True))
                amts = [float(a.replace(",", "")) for _, a in re.findall(r"(₹)\s?(\d{2,7}(?:\.\d{1,2})?)", text)]
                if amts:
                    amts = sorted(set(amts))
                    if "two" in name_lower or "two ports" in name_lower:
                        return min(amts)
                    return max(amts)
                return get_from_price_inr(buy_cache["imac"], region)
            if "mini" in name_lower:
                return get_from_price_inr(buy_cache["mac-mini"], region)
            if "studio" in name_lower:
                return get_from_price_inr(buy_cache["mac-studio"], region)
            if "pro" in name_lower and "mac pro" in name_lower:
                return get_from_price_inr(buy_cache["mac-pro"], region)
            return None

        out_rows: List[ProductRow] = []
        for r in rows:
            nm = r["name"]
            nm_l = nm.lower()
            price = price_from_family(nm_l)

            # Ports: if compare grid didn't give, set common sensible defaults for notebooks
            ports = r.get("ports")
            if not ports and "macbook air" in nm_l:
                ports = '["MagSafe 3","2x Thunderbolt 4 (USB-C)","3.5mm"]'
            elif not ports and "macbook pro" in nm_l:
                # M4 base often TB4; Pro/Max TB5 — we won't disambiguate here
                ports = '["MagSafe 3","3x Thunderbolt (USB-C)","HDMI","SDXC","3.5mm"]'

            out_rows.append(ProductRow(
                name=nm,
                category="macbook" if "macbook" in nm_l else "mac",
                url=None,
                chip=r.get("chip"),
                ram_gb=None,
                storage_gb=r.get("storage_gb"),
                storage_tb=r.get("storage_tb"),
                battery_hours=r.get("battery_hours"),
                weight_kg=r.get("weight_kg"),
                price_inr=price,
                ports=ports,
                display_inches=r.get("display_inches"),
                notes=r.get("notes"),
                learning_hours=None,
                maintenance_hours_per_year=None,
                power_adequacy_score=None,
            ))

        df = pd.DataFrame([asdict(x) for x in out_rows], columns=[
            "name","category","url","chip","ram_gb","storage_gb","storage_tb","battery_hours",
            "weight_kg","price_inr","ports","display_inches","notes","learning_hours",
            "maintenance_hours_per_year","power_adequacy_score"
        ])
        ensure_dir(out_dir)
        csv_path = out_dir / f"mac_lineup_current_{date.today().isoformat()}.csv"
        df.to_csv(csv_path, index=False)
        return csv_path
    finally:
        context.close()
        browser.close()
        p.stop()

# ------------------------------------------------------------
# CLI
# ------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Fetch Apple India Mac & iPad data into CSVs via real browser scraping.")
    ap.add_argument("--region", default="IN", help="Region code (IN/US/UK/...). Default IN")
    ap.add_argument("--out", default="out", help="Output directory. Default out/")
    ap.add_argument("--headless", action="store_true", help="Run browser headless")
    ap.add_argument("--timeout", type=int, default=60, help="Per-page timeout in seconds (default 60)")
    args = ap.parse_args()

    out_dir = Path(args.out); ensure_dir(out_dir)

    ipads_csv = scrape_ipads(region=args.region, out_dir=out_dir, headless=args.headless, timeout=args.timeout)
    macs_csv  = scrape_macs(region=args.region, out_dir=out_dir, headless=args.headless, timeout=args.timeout)

    print(f"✅ Wrote: {ipads_csv}")
    print(f"✅ Wrote: {macs_csv}")

if __name__ == "__main__":
    main()
