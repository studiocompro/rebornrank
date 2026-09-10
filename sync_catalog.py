#!/usr/bin/env python3
"""RebornRank catalogue synchronizer - V10.

Goals:
- Enrich the local static catalog.json from MyAnimeList through Jikan.
- Work in small slices so a GitHub Actions job never needs to process all entries.
- Skip recently synchronized entries to reduce API traffic.
- Stream logs immediately so GitHub Actions visibly progresses.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalog.json"
API = "https://api.jikan.moe/v4"

REQUEST_GAP = 1.65
TIMEOUT = 8
SEARCH_LIMIT = 8
MAX_RETRIES = 2
DEFAULT_REFRESH_DAYS = 30

_last_request_at = 0.0

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass


def norm(value: str | None) -> str:
    s = unicodedata.normalize("NFKD", value or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = (
        s.replace("’", "'")
        .replace("‘", "'")
        .replace("–", "-")
        .replace("—", "-")
        .replace("：", ":")
    )
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def throttle() -> None:
    global _last_request_at
    now = time.monotonic()
    wait = REQUEST_GAP - (now - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def get_json(url: str) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(MAX_RETRIES):
        throttle()
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "RebornRankCatalogueSync/3.0 (+https://rebornrank.pages.dev)",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 429:
                retry_after = exc.headers.get("Retry-After")
                try:
                    wait = min(8, max(2, int(retry_after or "3")))
                except ValueError:
                    wait = 3
                print(f"    Jikan 429 -> retry in {wait}s", flush=True)
                time.sleep(wait)
                continue
            if exc.code in {403, 408, 425, 500, 502, 503, 504}:
                wait = 2 + attempt * 2
                print(f"    Jikan HTTP {exc.code} -> retry in {wait}s", flush=True)
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            wait = 2 + attempt * 2
            print(f"    transient error -> retry in {wait}s: {exc}", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"Jikan unavailable after {MAX_RETRIES} attempts: {last}")


def endpoint_for(item: dict[str, Any]) -> str:
    return "anime" if item.get("kind") == "ANIME" else "manga"


def search_jikan(item: dict[str, Any]) -> list[dict[str, Any]]:
    q = item.get("title") or item.get("canonicalTitle") or item.get("id") or ""
    params = {"q": q, "limit": str(SEARCH_LIMIT), "sfw": "true"}
    url = f"{API}/{endpoint_for(item)}?{urllib.parse.urlencode(params)}"
    return (get_json(url).get("data") or [])


def titles_of(media: dict[str, Any]) -> list[str]:
    vals: list[str] = []
    for key in ("title", "title_english", "title_japanese"):
        if media.get(key):
            vals.append(str(media[key]))
    for entry in media.get("titles") or []:
        if isinstance(entry, dict) and entry.get("title"):
            vals.append(str(entry["title"]))
    for title in media.get("title_synonyms") or []:
        if title:
            vals.append(str(title))
    return list(dict.fromkeys(vals))


def similarity(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        shorter, longer = min(len(a), len(b)), max(len(a), len(b))
        return 0.90 + 0.07 * shorter / max(1, longer)
    return difflib.SequenceMatcher(None, a, b).ratio()


def candidate_year(media: dict[str, Any], endpoint: str) -> int | None:
    if isinstance(media.get("year"), int):
        return media["year"]
    block = media.get("aired") if endpoint == "anime" else media.get("published")
    try:
        year = (((block or {}).get("prop") or {}).get("from") or {}).get("year")
        return int(year) if year else None
    except (TypeError, ValueError):
        return None


def medium_bonus(item: dict[str, Any], media: dict[str, Any]) -> float:
    typ = norm(str(media.get("type") or ""))
    medium = norm(str(item.get("medium") or ""))
    fmt = norm(str(item.get("format") or ""))

    if item.get("kind") == "ANIME":
        return 0.02
    if medium == "manhwa":
        return 0.10 if typ == "manhwa" else -0.04
    if medium == "manhua":
        return 0.10 if typ == "manhua" else -0.04
    if fmt == "novel" or medium in {"novel", "light novel", "web novel"}:
        return 0.09 if typ in {"light novel", "novel"} else -0.05
    if medium == "manga":
        return 0.06 if typ in {"manga", "one shot", "oneshot"} else 0.0
    return 0.0


def candidate_score(item: dict[str, Any], media: dict[str, Any]) -> float:
    title = item.get("title") or item.get("canonicalTitle") or ""
    score = max((similarity(title, x) for x in titles_of(media)), default=0.0)
    score += medium_bonus(item, media)

    iy = item.get("year")
    cy = candidate_year(media, endpoint_for(item))
    if iy and cy:
        diff = abs(int(iy) - int(cy))
        if diff == 0:
            score += 0.06
        elif diff == 1:
            score += 0.03
        elif diff >= 5:
            score -= 0.04
    return score


def choose_candidate(item: dict[str, Any], results: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, float]:
    ranked = sorted(
        ((candidate_score(item, m), m) for m in results),
        key=lambda x: x[0],
        reverse=True,
    )
    if not ranked:
        return None, 0.0
    score, media = ranked[0]
    return (media, score) if score >= 0.64 else (None, score)


def name_list(media: dict[str, Any], *keys: str) -> list[str]:
    vals: list[str] = []
    for key in keys:
        for entry in media.get(key) or []:
            if isinstance(entry, dict) and entry.get("name"):
                vals.append(str(entry["name"]))
    return list(dict.fromkeys(vals))


def image_url(media: dict[str, Any]) -> str:
    images = media.get("images") or {}
    for family in ("webp", "jpg"):
        block = images.get(family) or {}
        for key in ("large_image_url", "image_url", "small_image_url"):
            if block.get(key):
                return str(block[key])
    return ""


def map_status(value: str | None, old: str | None) -> str:
    n = norm(value)
    if n in {"currently airing", "publishing"}:
        return "RELEASING"
    if n in {"finished airing", "finished"}:
        return "FINISHED"
    if n in {"not yet aired", "not yet published"}:
        return "NOT_YET_RELEASED"
    if n == "on hiatus":
        return "HIATUS"
    if n == "discontinued":
        return "CANCELLED"
    return old or ""


def parse_sync_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def should_refresh(item: dict[str, Any], refresh_days: int, force: bool) -> bool:
    if force:
        return True
    # Missing essential data: always try.
    if not item.get("cover") or not (item.get("malId") or item.get("jikanId")):
        return True
    if not item.get("description"):
        return True

    last = parse_sync_date(item.get("lastSynced"))
    if not last:
        return True
    age_days = (datetime.now(timezone.utc) - last.astimezone(timezone.utc)).days
    return age_days >= refresh_days


def apply_media(item: dict[str, Any], media: dict[str, Any], match: float) -> None:
    endpoint = endpoint_for(item)
    canonical = media.get("title_english") or media.get("title") or item.get("title") or ""
    cover = image_url(media)
    raw_score = media.get("score")
    score_100 = int(round(float(raw_score) * 10)) if isinstance(raw_score, (int, float)) else item.get("score")

    item["jikanId"] = media.get("mal_id")
    item["malId"] = media.get("mal_id")
    item["sourceName"] = "MyAnimeList (via Jikan)"
    item["sourceUrl"] = media.get("url") or item.get("sourceUrl") or ""
    item["canonicalTitle"] = canonical
    item["romajiTitle"] = media.get("title") or ""
    item["nativeTitle"] = media.get("title_japanese") or item.get("nativeTitle") or ""
    item["cover"] = cover or item.get("cover") or ""
    item["description"] = (media.get("synopsis") or media.get("background") or item.get("description") or "").strip()
    item["score"] = score_100
    item["popularity"] = media.get("members") if media.get("members") is not None else item.get("popularity")
    item["favourites"] = media.get("favorites") if media.get("favorites") is not None else item.get("favourites")
    item["episodes"] = media.get("episodes") if endpoint == "anime" else item.get("episodes")
    item["chapters"] = media.get("chapters") if endpoint == "manga" else item.get("chapters")
    item["volumes"] = media.get("volumes") if endpoint == "manga" else item.get("volumes")
    item["status"] = map_status(media.get("status"), item.get("status"))
    item["sourceStatus"] = media.get("status") or ""
    item["sourceFormat"] = media.get("type") or ""
    item["year"] = candidate_year(media, endpoint) or item.get("year")
    item["genres"] = name_list(media, "genres")
    tags = name_list(media, "genres", "themes", "demographics", "explicit_genres")
    item["sourceTags"] = [{"name": x, "rank": None} for x in tags[:14]]
    item["rank"] = media.get("rank")
    item["malPopularityRank"] = media.get("popularity")
    item["scoredBy"] = media.get("scored_by")
    item["matchConfidence"] = round(match, 3)

    if endpoint == "anime":
        item["studios"] = name_list(media, "studios")
        item["producers"] = name_list(media, "producers")[:8]
        trailer = (media.get("trailer") or {}).get("url") if isinstance(media.get("trailer"), dict) else None
        links = []
        if item["sourceUrl"]:
            links.append({"site": "MyAnimeList", "url": item["sourceUrl"], "type": "INFO"})
        if trailer:
            links.append({"site": "Trailer", "url": trailer, "type": "VIDEO"})
        item["externalLinks"] = links
    else:
        authors = []
        for author in media.get("authors") or []:
            if isinstance(author, dict) and author.get("name"):
                authors.append(str(author["name"]))
        item["authors"] = list(dict.fromkeys(authors))
        item["externalLinks"] = (
            [{"site": "MyAnimeList", "url": item["sourceUrl"], "type": "INFO"}]
            if item["sourceUrl"] else []
        )

    item["lastSynced"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def save_catalog(catalog: list[dict[str, Any]]) -> None:
    CATALOG_PATH.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=0, help="0-based start index")
    parser.add_argument("--count", type=int, default=28, help="maximum entries to inspect")
    parser.add_argument("--refresh-days", type=int, default=DEFAULT_REFRESH_DAYS)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if not CATALOG_PATH.exists():
        print(f"ERROR: missing {CATALOG_PATH}", file=sys.stderr)
        return 2

    catalog = json.loads(CATALOG_PATH.read_text("utf-8"))
    if not isinstance(catalog, list):
        print("ERROR: catalog.json must contain an array", file=sys.stderr)
        return 2

    start = max(0, args.start)
    stop = min(len(catalog), start + max(0, args.count))
    selected = list(range(start, stop))

    print(
        f"RebornRank V10: catalogue={len(catalog)} | slice={start}:{stop} "
        f"| refresh_days={args.refresh_days}"
    )

    found = 0
    unresolved = 0
    skipped = 0
    request_failures = 0

    for pos, idx in enumerate(selected, start=1):
        item = catalog[idx]
        title = item.get("title") or item.get("id") or f"item-{idx}"
        prefix = f"[{idx+1:03d}/{len(catalog):03d}]"

        if not should_refresh(item, args.refresh_days, args.force):
            skipped += 1
            print(f"{prefix} SKIP already enriched: {title}")
            continue

        print(f"{prefix} SEARCH {title}")
        try:
            results = search_jikan(item)
        except Exception as exc:
            request_failures += 1
            unresolved += 1
            print(f"  ! request failed: {exc}")
            continue

        media, match = choose_candidate(item, results)
        if not media:
            unresolved += 1
            print(f"  - unresolved (best match {match:.2f})")
            continue

        apply_media(item, media, match)
        found += 1
        print(
            f"  + MAL {media.get('mal_id')} | match {match:.2f} | "
            f"{'cover' if item.get('cover') else 'NO COVER'} | "
            f"score={item.get('score')}"
        )

        # Save after every successful item so the workspace always contains the
        # latest progress. The workflow commits the slice after this script exits.
        save_catalog(catalog)

    # Save even if the slice had only skips/failures.
    save_catalog(catalog)

    covers = sum(bool(x.get("cover")) for x in catalog)
    ids = sum(bool(x.get("malId") or x.get("jikanId")) for x in catalog)
    descriptions = sum(bool(x.get("description")) for x in catalog)

    print("\n=== Slice summary ===")
    print(f"Processed range : {start}:{stop}")
    print(f"Enriched        : {found}")
    print(f"Skipped         : {skipped}")
    print(f"Unresolved      : {unresolved}")
    print(f"Request failures: {request_failures}")
    print(f"TOTAL covers    : {covers}/{len(catalog)}")
    print(f"TOTAL MAL IDs   : {ids}/{len(catalog)}")
    print(f"TOTAL summaries : {descriptions}/{len(catalog)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
