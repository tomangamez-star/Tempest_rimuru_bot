#!/usr/bin/env python3
"""Public Shoob catalogue -> private Telegram archive -> Supabase metadata.

Media bytes are never written to Supabase Storage. Telegram returns a bot-
specific file_id which Rimuru can resend instantly from any permitted chat.
"""
import html, os, re, shutil, subprocess, time, uuid
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests
import psycopg2
from bs4 import BeautifulSoup
from selenium import webdriver
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

class PermanentCardError(ValueError):
    """One broken Shoob detail page, not a batch/network/database failure."""

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
        cur.execute("""CREATE TABLE IF NOT EXISTS shoob_scrape_failures (
          source_url TEXT PRIMARY KEY, gallery_page BIGINT DEFAULT 0,
          error_text TEXT DEFAULT '', attempts BIGINT DEFAULT 1,
          first_seen_at TIMESTAMPTZ DEFAULT NOW(), last_seen_at TIMESTAMPTZ DEFAULT NOW())""")
        cur.execute("""CREATE TABLE IF NOT EXISTS shoob_scraper_state (
          state_key TEXT PRIMARY KEY, next_page BIGINT DEFAULT 1,
          last_completed_page BIGINT DEFAULT 0, status TEXT DEFAULT 'new',
          updated_at TIMESTAMPTZ DEFAULT NOW())""")
        for column, definition in {
            "current_page": "BIGINT DEFAULT 0", "total_pages": "BIGINT DEFAULT 2404",
            "run_id": "TEXT DEFAULT ''", "run_started_at": "TIMESTAMPTZ",
            "run_finished_at": "TIMESTAMPTZ", "last_success_at": "TIMESTAMPTZ",
            "heartbeat_at": "TIMESTAMPTZ", "cards_archived_latest": "BIGINT DEFAULT 0",
            "cards_skipped_latest": "BIGINT DEFAULT 0", "cards_failed_latest": "BIGINT DEFAULT 0",
            "pages_completed_latest": "BIGINT DEFAULT 0", "elapsed_seconds": "DOUBLE PRECISION DEFAULT 0",
            "gallery_avg_ms": "DOUBLE PRECISION DEFAULT 0", "telegram_avg_ms": "DOUBLE PRECISION DEFAULT 0",
            "postgres_avg_ms": "DOUBLE PRECISION DEFAULT 0", "last_error": "TEXT DEFAULT ''"
        }.items():
            cur.execute(f"ALTER TABLE shoob_scraper_state ADD COLUMN IF NOT EXISTS {column} {definition}")
    conn.commit()

def db_retry(conn, operation, attempts=4):
    for attempt in range(attempts):
        try:
            return operation()
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as exc:
            try: conn.rollback()
            except Exception: pass
            if attempt + 1 >= attempts: raise
            wait = 1.5 * (attempt + 1)
            print(f"[shoob] Postgres busy; retrying in {wait:.1f}s: {exc}", flush=True)
            time.sleep(wait)

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

def run_state(conn, **values):
    allowed = {
        "next_page", "last_completed_page", "current_page", "total_pages", "status", "run_id",
        "run_started_at", "run_finished_at", "last_success_at", "heartbeat_at",
        "cards_archived_latest", "cards_skipped_latest", "cards_failed_latest",
        "pages_completed_latest", "elapsed_seconds", "gallery_avg_ms", "telegram_avg_ms",
        "postgres_avg_ms", "last_error"
    }
    values = {key: value for key, value in values.items() if key in allowed}
    if not values: return
    columns = list(values)
    assignments = ",".join(f"{key}=EXCLUDED.{key}" for key in columns)
    placeholders = ",".join(["%s"] * (len(columns) + 1))
    sql = f"""INSERT INTO shoob_scraper_state(state_key,{','.join(columns)},updated_at)
      VALUES({placeholders},NOW()) ON CONFLICT(state_key) DO UPDATE SET
      {assignments},updated_at=NOW()"""
    def execute():
        with conn.cursor() as cur: cur.execute(sql, ["main", *[values[key] for key in columns]])
        conn.commit()
    db_retry(conn, execute)

def exists(conn, source):
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM shoob_cards WHERE source_url=%s AND telegram_file_id<>'' LIMIT 1", (source,))
        return cur.fetchone() is not None

def quarantine_failure(conn, source, page, error):
    def execute():
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shoob_scrape_failures(source_url,gallery_page,error_text,attempts,last_seen_at)
              VALUES(%s,%s,%s,1,NOW()) ON CONFLICT(source_url) DO UPDATE SET
              gallery_page=EXCLUDED.gallery_page,error_text=EXCLUDED.error_text,
              attempts=shoob_scrape_failures.attempts+1,last_seen_at=NOW()""",
              (source, page, clean(error)[:900]))
        conn.commit()
    db_retry(conn, execute)

def driver():
    chrome_binary = (
        os.getenv("CHROME_PATH")
        or shutil.which("chrome")
        or shutil.which("google-chrome")
        or shutil.which("google-chrome-stable")
        or shutil.which("chromium")
        or shutil.which("chromium-browser")
    )
    if chrome_binary:
        version_text = subprocess.check_output(
            [chrome_binary, "--version"], text=True, stderr=subprocess.STDOUT
        )
        # Chrome may print a warning timestamp before the version line, e.g.
        # "[0823/083832...] ... Google Chrome 151.0...". Match the browser
        # label explicitly so the timestamp can never become version_main.
        match = re.search(r"(?:Google Chrome|Chromium)\s+(\d+)\.", version_text, re.I)
        if match:
            print(f"[shoob] Chrome {match.group(1)} detected at {chrome_binary}", flush=True)

    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new"); options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage"); options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--disable-blink-features=AutomationControlled")
    if chrome_binary:
        options.binary_location = chrome_binary
    print("[shoob] launching Chrome with the workflow-matched ChromeDriver", flush=True)
    browser = webdriver.Chrome(options=options)
    browser.set_page_load_timeout(45)
    print("[shoob] Chrome session ready", flush=True)
    return browser

def gallery_urls(browser, page):
    print(f"[shoob] loading gallery page {page}", flush=True)
    browser.get(f"{BASE}/cards?page={page}"); time.sleep(4)
    seen, urls = set(), []
    for node in browser.find_elements(By.XPATH, "//a[contains(@href, '/cards/info/')]"):
        href = urljoin(BASE, node.get_attribute("href") or "")
        if "/cards/info/" in href and href not in seen: seen.add(href); urls.append(href)
    print(f"[shoob] gallery page {page}: {len(urls)} card link(s)", flush=True)
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
    if not title: raise PermanentCardError("card title not found")
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
    if not name or not series or not tier or not media_url: raise PermanentCardError("incomplete card metadata")
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
    if ext == ".gif": method, field, stored = "sendAnimation", "animation", "animation"
    elif card["media_type"] == "image": method, field, stored = "sendPhoto", "photo", "photo"
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
    conn = psycopg2.connect(DATABASE_URL, connect_timeout=20, application_name="rimuru_shoob_scraper",
                            keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=5)
    browser = None; run_started = time.monotonic(); run_id = uuid.uuid4().hex[:12]
    inserted = skipped = failed = pages_done = 0
    gallery_samples, telegram_samples, postgres_samples = [], [], []
    try:
        ensure_schema(conn); first = state(conn)
        if first > END_PAGE:
            run_state(conn, status="completed", current_page=END_PAGE, total_pages=END_PAGE,
                      heartbeat_at=datetime.now(timezone.utc), run_finished_at=datetime.now(timezone.utc))
            print("Shoob catalogue already complete"); return
        last = min(END_PAGE, first + BATCH_SIZE - 1)
        run_state(conn, status="running", current_page=first, total_pages=END_PAGE, run_id=run_id,
                  run_started_at=datetime.now(timezone.utc), run_finished_at=None,
                  heartbeat_at=datetime.now(timezone.utc), cards_archived_latest=0,
                  cards_skipped_latest=0, cards_failed_latest=0, pages_completed_latest=0,
                  elapsed_seconds=0, gallery_avg_ms=0, telegram_avg_ms=0, postgres_avg_ms=0, last_error="")
        browser = driver()
        for page in range(first, last + 1):
            run_state(conn, status="running", current_page=page, heartbeat_at=datetime.now(timezone.utc))
            gallery_started = time.monotonic(); urls = gallery_urls(browser, page)
            gallery_samples.append((time.monotonic() - gallery_started) * 1000)
            if not urls:
                raise RuntimeError(f"Shoob gallery page {page} returned no card links; progress retained")
            print(f"page {page}: {len(urls)} cards")
            page_failed = 0; page_quarantined = 0; page_error = ""
            for source in urls:
                if exists(conn, source): skipped += 1; continue
                card_saved = False; card = None; archived = None; last_exception = None
                for attempt in range(3):
                    try:
                        if card is None: card = detail(browser, source)
                        if archived is None:
                            started = time.monotonic(); archived = archive(card)
                            telegram_samples.append((time.monotonic() - started) * 1000)
                        started = time.monotonic(); db_retry(conn, lambda: save_card(conn, card, archived))
                        postgres_samples.append((time.monotonic() - started) * 1000)
                        inserted += 1; card_saved = True
                        print(f"archived {card['name']} T{card['tier']}"); time.sleep(DELAY); break
                    except Exception as exc:
                        last_exception = exc
                        page_error = f"{source}: {exc}"[:900]
                        print(f"attempt {attempt + 1}/3 failed {page_error}", flush=True)
                        if attempt < 2: time.sleep(2 * (attempt + 1))
                if not card_saved:
                    failed += 1
                    if isinstance(last_exception, PermanentCardError):
                        try:
                            quarantine_failure(conn, source, page, str(last_exception))
                            page_quarantined += 1
                            print(f"quarantined malformed card on page {page}: {source} ({last_exception})", flush=True)
                        except Exception as quarantine_error:
                            page_failed += 1
                            page_error = f"could not quarantine {source}: {quarantine_error}"[:900]
                    else:
                        page_failed += 1
                elapsed = time.monotonic() - run_started
                run_state(conn, heartbeat_at=datetime.now(timezone.utc), cards_archived_latest=inserted,
                          cards_skipped_latest=skipped, cards_failed_latest=failed,
                          pages_completed_latest=pages_done, elapsed_seconds=elapsed,
                          gallery_avg_ms=sum(gallery_samples)/len(gallery_samples),
                          telegram_avg_ms=(sum(telegram_samples)/len(telegram_samples) if telegram_samples else 0),
                          postgres_avg_ms=(sum(postgres_samples)/len(postgres_samples) if postgres_samples else 0),
                          last_error=page_error if page_failed else "")
            # One or two isolated malformed detail pages must not trap the
            # catalogue forever. Three or more on one gallery page probably
            # means Shoob changed its layout, so retain that page for safety.
            if page_quarantined >= 3:
                page_failed += page_quarantined
                page_error = f"{page_quarantined} malformed cards on page {page}; possible Shoob layout change"
            if page_failed:
                # Never move beyond a partially failed page. Already archived cards
                # are idempotently skipped on the next scheduled retry.
                run_state(conn, status="stalled", next_page=page, current_page=page,
                          last_completed_page=page - 1, run_finished_at=datetime.now(timezone.utc),
                          heartbeat_at=datetime.now(timezone.utc), last_error=page_error)
                print(f"page {page} retained for retry: {page_failed} blocking failure(s), {page_quarantined} quarantined", flush=True)
                break
            if page_quarantined:
                print(f"page {page}: continued past {page_quarantined} quarantined malformed card(s)", flush=True)
            pages_done += 1
            run_state(conn, next_page=page + 1, last_completed_page=page, current_page=page,
                      pages_completed_latest=pages_done, last_success_at=datetime.now(timezone.utc),
                      heartbeat_at=datetime.now(timezone.utc), last_error="")
        else:
            final_status = "completed" if last >= END_PAGE else "waiting"
            run_state(conn, status=final_status, next_page=last + 1, last_completed_page=last,
                      current_page=last, run_finished_at=datetime.now(timezone.utc),
                      heartbeat_at=datetime.now(timezone.utc), last_success_at=datetime.now(timezone.utc),
                      elapsed_seconds=time.monotonic() - run_started)
    except Exception as exc:
        try:
            run_state(conn, status="stalled", run_finished_at=datetime.now(timezone.utc),
                      heartbeat_at=datetime.now(timezone.utc), elapsed_seconds=time.monotonic() - run_started,
                      last_error=str(exc)[:900])
        except Exception: pass
        raise
    finally:
        if browser:
            try: browser.quit()
            except Exception: pass
        conn.close()
    print(f"done pages {first}-{last}: archived={inserted} skipped={skipped} failed={failed}")

if __name__ == "__main__": main()
