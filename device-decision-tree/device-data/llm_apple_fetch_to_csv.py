# ipad_fetch_to_csv.py
# Compact, production-friendly scraper for Apple's iPad lineup (India).
# - Playwright fetches BUY + Marketing pages for each iPad family
# - Regex-based parsing first; if a field can't be parsed, we call OpenAI
# - If an exception occurs, we ask OpenAI to summarize the error & suggest fixes
#
# Install:
# python -m venv .venv && source .venv/bin/activate
# playwright install
# export OPENAI_API_KEY=sk-...
# python ipad_fetch_to_csv.py --region IN --out out/ --headless

# Usage:
#   python llm_apple_fetch_to_csv.py --region IN --out out/ [--headless] [--timeout 60]
#
# Output:
#   out/ipads_india_specs_<YYYY-MM-DD>.csv

from __future__ import annotations

import argparse, json, os, re, sys, time, traceback
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
from openai import OpenAI

# ---------- Config ----------

FAMILIES = [
    # name, size_hint, buy_url_key, marketing_url_key
    ("iPad Pro 11″ (M4)", 11.1, "ipad-pro", "ipad-pro"),
    ("iPad Pro 13″ (M4)", 13.0, "ipad-pro", "ipad-pro"),
    ("iPad Air 11″ (M3)", 10.86, "ipad-air", "ipad-air"),
    ("iPad Air 13″ (M3)", 12.9, "ipad-air", "ipad-air"),
    ("iPad 11″ (A16)", 10.86, "ipad", "ipad"),
    ("iPad mini 8.3″ (A17 Pro)", 8.3, "ipad-mini", "ipad-mini"),
]

BUY_URLS = {
    "ipad-pro":  "https://www.apple.com/{region}/shop/buy-ipad/ipad-pro",
    "ipad-air":  "https://www.apple.com/{region}/shop/buy-ipad/ipad-air",
    "ipad":      "https://www.apple.com/{region}/shop/buy-ipad/ipad",
    "ipad-mini": "https://www.apple.com/{region}/shop/buy-ipad/ipad-mini",
}
MKT_URLS = {
    "ipad-pro":  "https://www.apple.com/{region}/ipad-pro/",
    "ipad-air":  "https://www.apple.com/{region}/ipad-air/",
    "ipad":      "https://www.apple.com/{region}/ipad-11/",
    "ipad-mini": "https://www.apple.com/{region}/ipad-mini/",
}

CURRENCY = ("INR", "₹")  # for region=IN

# ---------- OpenAI helpers (fallback + error explain) ----------

def get_client() -> Optional[OpenAI]:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        return None
    return OpenAI()

def llm_extract_fields(client: OpenAI, html: str, wanted: Dict[str, str]) -> Dict[str, Any]:
    """
    Ask the LLM to extract fields from messy HTML when regex fails.
    `wanted` is a mapping: field_name -> instruction (what to extract).
    Returns dict with best-effort parsed values.
    """
    sys_msg = (
        "You are a precise HTML parser. Extract numeric values and short strings.\n"
        "If a field is not present, return null. Use numbers only for prices/weights/sizes."
    )
    instructions = {
        "task": "Extract fields from Apple iPad HTML (India). Return JSON only.",
        "fields": wanted,
        "notes": [
            "Prices are in INR; strip commas; return numeric price_inr.",
            "Weight should be Wi-Fi model in kilograms (e.g., 0.444).",
            "Display inches like 11.1 or 13.0 as float.",
            "Chip should be like 'M4', 'M3', 'A16', 'A17 Pro'.",
            "Ports should be 'USB-C' or 'USB-C (Thunderbolt/USB 4)'.",
            "Storage: base and max in GB (e.g., 128, 2048)."
        ],
    }
    resp = client.responses.create(
        model="gpt-4.1-mini",
        input=[
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": json.dumps(instructions)},
            {"role": "user", "content": html[:180000]}  # cap for safety
        ],
        temperature=0,
        response_format={"type": "json_object"},
    )
    try:
        return json.loads(resp.output_text)
    except Exception:
        return {}

def llm_explain_error(client: Optional[OpenAI], err_text: str) -> str:
    if not client:
        return err_text
    prompt = (
        "Summarize this Python scraping error in one paragraph with a bullet list of likely fixes. "
        "Keep it concise and actionable:\n\n" + err_text
    )
    resp = client.responses.create(model="gpt-4.1-mini", input=prompt, temperature=0.2)
    return resp.output_text.strip()

# ---------- Browser ----------

def launch_browser(headless: bool):
    p = sync_playwright().start()
    browser = p.chromium.launch(headless=headless)
    ctx = browser.new_context(
        user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"),
        viewport={"width": 1440, "height": 1000},
        locale="en-IN",
    )
    page = ctx.new_page()
    return p, browser, ctx, page

def get_html(page, url: str, timeout: int = 60) -> str:
    page.set_default_timeout(timeout * 1000)
    page.goto(url, wait_until="networkidle")
    time.sleep(0.8)
    return page.content()

# ---------- Parsers (regex-first; LLM fallback) ----------

PRICE_RE = re.compile(r"(?:From|Starting at)\s*₹\s?(\d[\d,]*)", re.I)
ANY_INR_RE = re.compile(r"₹\s?(\d[\d,]*)")
GRAM_RE = re.compile(r"(\d{2,4})\s*g\b", re.I)
INCH_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:[\"”]|-?inch|\s?in)\b", re.I)
CHIP_RE = re.compile(r"\b(M\d+(?:\s?(Pro|Max))?|A\d+\s?Pro|A\d+)\b", re.I)
PORTS_THOR = re.compile(r"Thunderbolt\s*/?\s*USB\s*4", re.I)
PORTS_USBC = re.compile(r"USB[\-\u2011\u2013\u2014]?C", re.I)
STORAGE_GB_RE = re.compile(r"(\d{2,5})\s*GB", re.I)
STORAGE_TB_RE = re.compile(r"(\d)\s*TB", re.I)

def parse_price_inr(html: str, size_hint: float) -> Optional[float]:
    """
    On Pro/Air buy pages there can be two 'From' prices (11 vs 13).
    Heuristic: collect all INR and pick min for ~11-inch, max for ~13-inch.
    """
    text = BeautifulSoup(html, "lxml").get_text(" ", strip=True)
    nums = [int(x.replace(",", "")) for x in ANY_INR_RE.findall(text)]
    if not nums:
        return None
    nums = sorted(set(nums))
    if size_hint >= 12.8 and len(nums) > 1:
        return float(max(nums))
    return float(min(nums))

def parse_weight_kg(html: str) -> Optional[float]:
    m = GRAM_RE.search(html)
    if not m:
        return None
    grams = int(m.group(1))
    return round(grams / 1000.0, 3)

def parse_display_inches(html: str) -> Optional[float]:
    m = INCH_RE.search(html)
    return float(m.group(1)) if m else None

def parse_chip(html: str) -> Optional[str]:
    m = CHIP_RE.search(html)
    return m.group(0).replace("  ", " ") if m else None

def parse_ports(html: str) -> Optional[str]:
    if PORTS_THOR.search(html):
        return "USB-C (Thunderbolt/USB 4)"
    if PORTS_USBC.search(html):
        return "USB-C"
    return None

def parse_storage_bounds(html: str) -> (Optional[int], Optional[int]):
    gbs = [int(x) for x in STORAGE_GB_RE.findall(html)]
    tbs = [int(x) * 1000 for x in STORAGE_TB_RE.findall(html)]
    all_caps = sorted(set(gbs + tbs))
    if not all_caps:
        return None, None
    return min(all_caps), max(all_caps)

# ---------- Main scrape ----------

def scrape_ipads(region: str, out_dir: Path, headless: bool, timeout: int) -> Path:
    ensure_dir(out_dir)
    client = get_client()

    p, browser, ctx, page = launch_browser(headless=headless)
    try:
        rows: List[Dict[str, Any]] = []
        for name, size_hint, buy_key, mkt_key in FAMILIES:
            try:
                buy_url = BUY_URLS[buy_key].format(region=region.lower())
                mkt_url = MKT_URLS[mkt_key].format(region=region.lower())

                buy_html = get_html(page, buy_url, timeout)
                mkt_html = get_html(page, mkt_url, timeout)

                # Regex-first
                price_inr = parse_price_inr(buy_html, size_hint)
                weight_kg = parse_weight_kg(mkt_html)  # Wi-Fi model weight is usually in Tech Specs
                display_in = parse_display_inches(mkt_html) or size_hint
                chip = parse_chip(mkt_html) or parse_chip(buy_html)
                ports = parse_ports(mkt_html) or parse_ports(buy_html)
                base_gb, max_gb = parse_storage_bounds(mkt_html + " " + buy_html)

                # LLM fallback for any missing field
                if client and (price_inr is None or weight_kg is None or chip is None or ports is None or base_gb is None or max_gb is None):
                    wanted = {
                        "price_inr": "From price in INR (Wi-Fi model) as a number (e.g., 99900).",
                        "weight_kg": "Wi-Fi model weight in kilograms as a number (e.g., 0.444).",
                        "display_inches": "Diagonal display size in inches as a float (e.g., 11.1).",
                        "chip": "Chip string like 'M4', 'M3', 'A16', 'A17 Pro'.",
                        "ports": "Either 'USB-C' or 'USB-C (Thunderbolt/USB 4)'.",
                        "storage_gb_min": "Base storage (smallest capacity) in GB as a number.",
                        "storage_gb_max": "Max storage in GB as a number.",
                    }
                    llm_res = llm_extract_fields(client, mkt_html + "\n\n" + buy_html, wanted)
                    price_inr = price_inr or llm_res.get("price_inr")
                    weight_kg = weight_kg or llm_res.get("weight_kg")
                    display_in = display_in or llm_res.get("display_inches")
                    chip = chip or llm_res.get("chip")
                    ports = ports or llm_res.get("ports")
                    base_gb = base_gb or llm_res.get("storage_gb_min")
                    max_gb = max_gb or llm_res.get("storage_gb_max")

                rows.append({
                    "name": name,
                    "category": "ipad",
                    "url": buy_url,
                    "chip": chip,
                    "ram_gb": None,                      # Apple doesn't list RAM on marketing pages
                    "storage_gb": base_gb,
                    "storage_tb": (max_gb/1000.0) if max_gb else None,
                    "battery_hours": 10.0,               # Apple's standard iPad claim (web/video)
                    "weight_kg": weight_kg,
                    "price_inr": float(price_inr) if price_inr else None,
                    "ports": ports,
                    "display_inches": display_in,
                    "notes": "India ‘From’ price; Wi-Fi model weight.",
                    "learning_hours": None,
                    "maintenance_hours_per_year": None,
                    "power_adequacy_score": None,
                })
            except Exception as e:
                tb = traceback.format_exc()
                msg = f"[{name}] scrape failed: {e}\n{tb}"
                print("—"*60)
                print("ERROR:", name)
                print(llm_explain_error(client, msg))
                print("—"*60)

        df = pd.DataFrame(rows, columns=[
            "name","category","url","chip","ram_gb","storage_gb","storage_tb",
            "battery_hours","weight_kg","price_inr","ports","display_inches",
            "notes","learning_hours","maintenance_hours_per_year","power_adequacy_score"
        ])
        csv_path = out_dir / f"ipads_india_specs_{date.today().isoformat()}.csv"
        df.to_csv(csv_path, index=False)
        print(f"✅ Wrote: {csv_path}")
        return csv_path
    finally:
        ctx.close(); browser.close()
        try:
            # stop Playwright cleanly
            page.context.browser._impl_obj._loop._playwright.stop()
        except Exception:
            pass

# ---------- Utils ----------

def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)

# ---------- CLI ----------

def main():
    ap = argparse.ArgumentParser(description="Fetch Apple iPad data (India) to CSV, with OpenAI-assisted fallbacks.")
    ap.add_argument("--region", default="IN", help="Region code (default IN).")
    ap.add_argument("--out", default="out", help="Output folder.")
    ap.add_argument("--headless", action="store_true", help="Run headless browser.")
    ap.add_argument("--timeout", type=int, default=60, help="Per-page timeout seconds.")
    args = ap.parse_args()

    out_dir = Path(args.out); ensure_dir(out_dir)
    scrape_ipads(region=args.region, out_dir=out_dir, headless=args.headless, timeout=args.timeout)

if __name__ == "__main__":
    main()
