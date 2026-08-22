#!/usr/bin/env python3
"""Public Shoob catalogue -> private Telegram archive -> Supabase metadata.

Media bytes are never written to Supabase Storage. Telegram returns a bot-
specific file_id which Rimuru can resend instantly from any permitted chat.
"""
import html, os, re, time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests
import psycopg2
from bs4 import BeautifulSoup
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By

BASE = os.getenv("SHOOB_BASE_URL", "https://shoob.gg")
START_PAGE = int(os.getenv("SHOOB_START_PAGE", "1"))
END_PAGE = int(os.getenv("SHOOB_END_PAGE", "2404"))
BATCH_SIZE = max(1, int(os.getenv("SHOOB_BATCH_SIZE", "20")))
DELAY = max(0.6, float(os.getenv("SHOOB_SEND_DELAY", "1.25")))
DATABASE_URL = os.getenv("DATABASE_URL", "")
TOKEN = os.getenv("TELEGRAM_TOKEN", "")
ARCHIVE_CHAT = os.getenv("SHOOB_ARCHIVE_CHAT_ID", "")

if not DATABASE_URL or not TOKEN or not ARCHIVE_CHAT:
    raise RuntimeError("DATABASE_URL, TELEGRAM_TOKEN and SHOOB_ARCHIVE_CHAT_ID are required")

def clean(v): return " ".join(str(v or "").split()).strip()
def normalize(v):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", clean(v).lower().replace("&", " and "))).strip()
def tier_of(text):
    m = re.search(r"\b(?:tier\s*)?t?([1-6])\b", clean(text), re.I)
    return int(m.group(1)) if m else 0
def card_media(url): return bool(url and "/images/cards/" in url.lower() and "shoob_logo" not in url.lower())

def ensure_schema(conn):
    with conn.cursor() as cur:
        cur.execute("""CREATE TABLE IF NOT EXISTS shoob_cards (
          source_url TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
          series TEXT DEFAULT '', tier BIGINT DEFAULT 0, media_url TEXT DEFAULT '',
          media_type TEXT DEFAULT 'image', telegram_file_id TEXT NOT NULL,
          telegram_media_type TEXT DEFAULT 'photo', telegram_message_id BIGINT DEFAULT 0,
          archive_chat_id BIGINT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW())""")
        cur.execute("CREATE INDEX IF NOT EXISTS shoob_cards_normalized_name_idx ON shoob_cards(normalized_name)")
        cur.execute("CREATE INDEX IF NOT EXISTS shoob_cards_tier_idx ON shoob_cards(tier)")
        cur.execute("""CREATE TABLE IF NOT EXISTS shoob_scraper_state (
          state_key TEXT PRIMARY KEY, next_page BIGINT DEFAULT 1,
          last_completed_page BIGINT DEFAULT 0, status TEXT DEFAULT 'new',
          updated_at TIMESTAMPTZ DEFAULT NOW())""")
    conn.commit()

def state(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT next_page FROM shoob_scraper_state WHERE state_key='main'")
        row = cur.fetchone()
    return max(START_PAGE, int(row[0]) if row else START_PAGE)

def save_state(conn, next_page, completed, status="running"):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO shoob_scraper_state(state_key,next_page,last_completed_page,status,updated_at)
          VALUES('main',%s,%s,%s,NOW()) ON CONFLICT(state_key) DO UPDATE SET
          next_page=EXCLUDED.next_page,last_completed_page=EXCLUDED.last_completed_page,
          status=EXCLUDED.status,updated_at=NOW()""", (next_page, completed, status))
    conn.commit()

def exists(conn, source):
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM shoob_cards WHERE source_url=%s AND telegram_file_id<>'' LIMIT 1", (source,))
        return cur.fetchone() is not None

def driver():
    options = uc.ChromeOptions()
    options.add_argument("--headless=new"); options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage"); options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--disable-blink-features=AutomationControlled")
    return uc.Chrome(options=options, use_subprocess=True)

def gallery_urls(browser, page):
    browser.get(f"{BASE}/cards?page={page}"); time.sleep(4)
    seen, urls = set(), []
    for node in browser.find_elements(By.XPATH, "//a[contains(@href, '/cards/info/')]"):
        href = urljoin(BASE, node.get_attribute("href") or "")
        if "/cards/info/" in href and href not in seen: seen.add(href); urls.append(href)
    return urls

def detail(browser, source):
    browser.get(source); time.sleep(1.5)
    soup = BeautifulSoup(browser.page_source, "html.parser")
    title = ""
    for selector in ["div.text-xl.font-bold.text-center.mt-4", "div.text-xl.font-bold", "h1", "h2", "h3"]:
        for node in soup.select(selector):
            candidate = clean(node.get_text(" ", strip=True))
            if candidate and tier_of(candidate): title = candidate; break
        if title: break
    if not title: raise ValueError("card title not found")
    tier = tier_of(title)
    name = re.sub(r"\s*(?:-|\||:)?\s*(?:T|Tier\s*)[1-6]\s*$", "", title, flags=re.I).strip()
    crumbs = [clean(n.get_text(" ", strip=True)) for n in soup.select(".breadcrumb-new li, .breadcrumb li, nav[aria-label='breadcrumb'] li")]
    series = ""
    for i, item in enumerate(crumbs):
        if tier_of(item) and i + 1 < len(crumbs): series = crumbs[i + 1]; break
    if not series and len(crumbs) >= 2: series = crumbs[-2]
    media_url = ""; media_type = "image"
    for node in soup.select("video, video source, source"):
        for attr in ("src", "data-src", "data-video", "data-url"):
            url = urljoin(BASE, node.get(attr) or "")
            if card_media(url): media_url, media_type = url, "video"; break
        if media_url: break
    if not media_url:
        for node in soup.select("img"):
            for attr in ("src", "data-src", "data-lazy-src", "data-original"):
                url = urljoin(BASE, node.get(attr) or "")
                if card_media(url): media_url = url; break
            if media_url: break
    if not name or not series or not tier or not media_url: raise ValueError("incomplete card metadata")
    return {"source_url": source, "name": name, "normalized_name": normalize(name), "series": series,
            "tier": tier, "media_url": media_url, "media_type": media_type}

def api(method, payload):
    endpoint = f"https://api.telegram.org/bot{TOKEN}/{method}"
    for attempt in range(6):
        response = requests.post(endpoint, data=payload, timeout=90)
        data = response.json()
        if response.ok and data.get("ok"): return data["result"]
        retry = int((data.get("parameters") or {}).get("retry_after") or 0)
        if retry: time.sleep(retry + 1)
        elif attempt < 5: time.sleep(2 + attempt)
    raise RuntimeError(data.get("description") or "Telegram upload failed")

def archive(card):
    caption = f"🎴 {card['name']}\n🎬 {card['series']}\n⭐ T{card['tier']} SHOOB ORIGINAL\n🔗 {card['source_url']}"
    ext = os.path.splitext(urlparse(card["media_url"]).path.lower())[1]
    if card["media_type"] == "image": method, field, stored = "sendPhoto", "photo", "photo"
    elif ext == ".gif": method, field, stored = "sendAnimation", "animation", "animation"
    elif ext in (".mp4", ".mov", ".m4v"): method, field, stored = "sendVideo", "video", "video"
    else: method, field, stored = "sendDocument", "document", "document"
    msg = api(method, {"chat_id": ARCHIVE_CHAT, field: card["media_url"], "caption": caption})
    if stored == "photo": file_id = (msg.get("photo") or [{}])[-1].get("file_id")
    else: file_id = (msg.get(stored) or {}).get("file_id")
    if not file_id: raise RuntimeError("Telegram returned no file_id")
    return file_id, stored, int(msg.get("message_id") or 0)

def save_card(conn, card, archived):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO shoob_cards(source_url,name,normalized_name,series,tier,media_url,media_type,
          telegram_file_id,telegram_media_type,telegram_message_id,archive_chat_id,updated_at)
          VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW()) ON CONFLICT(source_url) DO UPDATE SET
          name=EXCLUDED.name,normalized_name=EXCLUDED.normalized_name,series=EXCLUDED.series,tier=EXCLUDED.tier,
          media_url=EXCLUDED.media_url,media_type=EXCLUDED.media_type,telegram_file_id=EXCLUDED.telegram_file_id,
          telegram_media_type=EXCLUDED.telegram_media_type,telegram_message_id=EXCLUDED.telegram_message_id,
          archive_chat_id=EXCLUDED.archive_chat_id,updated_at=NOW()""",
          (card["source_url"], card["name"], card["normalized_name"], card["series"], card["tier"],
           card["media_url"], card["media_type"], archived[0], archived[1], archived[2], int(ARCHIVE_CHAT)))
    conn.commit()

def main():
    conn = psycopg2.connect(DATABASE_URL); ensure_schema(conn)
    first = state(conn)
    if first > END_PAGE: print("Shoob catalogue already complete"); return
    last = min(END_PAGE, first + BATCH_SIZE - 1); browser = driver()
    inserted = skipped = failed = 0
    try:
        for page in range(first, last + 1):
            urls = gallery_urls(browser, page); print(f"page {page}: {len(urls)} cards")
            for source in urls:
                try:
                    if exists(conn, source): skipped += 1; continue
                    card = detail(browser, source); archived = archive(card); save_card(conn, card, archived)
                    inserted += 1; print(f"archived {card['name']} T{card['tier']}"); time.sleep(DELAY)
                except Exception as exc: failed += 1; print(f"skip {source}: {exc}")
            save_state(conn, page + 1, page)
        save_state(conn, last + 1, last, "completed" if last >= END_PAGE else "waiting")
    finally:
        browser.quit(); conn.close()
    print(f"done pages {first}-{last}: archived={inserted} skipped={skipped} failed={failed}")

if __name__ == "__main__": main()
