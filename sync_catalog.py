#!/usr/bin/env python3
"""Refresh RebornRank's local catalogue from MyAnimeList through Jikan v4.

Why Jikan?
- AniList currently returns HTTP 403 from GitHub-hosted runners for this project.
- Jikan is an unauthenticated REST API backed by MyAnimeList.

The public website never calls Jikan. This script runs in GitHub Actions and writes
all metadata into catalog.json so RebornRank can serve a static local catalogue.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalog.json"
API = "https://api.jikan.moe/v4"
REQUEST_GAP = float(os.getenv("JIKAN_REQUEST_GAP", "1.35"))  # ~44 req/min
TIMEOUT = int(os.getenv("JIKAN_TIMEOUT", "30"))
SEARCH_LIMIT = 10
MAX_RETRIES = 5

_last_request_at = 0.0


def norm(value: str | None) -> str:
    s = unicodedata.normalize("NFKD", value or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    # Normalize typographic punctuation before stripping it.
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


def _throttle() -> None:
    global _last_request_at
    now = time.monotonic()
    wait = REQUEST_GAP - (now - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def get_json(url: str, tries: int = MAX_RETRIES) -> dict[str, Any]:
    """GET JSON with polite throttling and retry/backoff for public Jikan limits."""
    last: Exception | None = None
    for attempt in range(tries):
        _throttle()
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "RebornRankCatalogueSync/2.0 (+https://rebornrank.pages.dev)",
                "Cache-Control": "no-cache",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            # 429 is the normal rate-limit response. 5xx can also occur while
            # Jikan refreshes a MAL cache entry. Retry both.
            if exc.code == 429:
                retry = int(exc.headers.get("Retry-After") or 4)
                time.sleep(min(30, max(3, retry)))
                continue
            if exc.code in {403, 408, 425, 500, 502, 503, 504}:
                time.sleep(min(20, 2.5 * (attempt + 1)))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            time.sleep(min(20, 2.5 * (attempt + 1)))
    raise RuntimeError(f"Jikan unavailable after {tries} attempts: {last}")


def search_endpoint(item: dict[str, Any]) -> str:
    return "anime" if item.get("kind") == "ANIME" else "manga"


def search_jikan(item: dict[str, Any]) -> list[dict[str, Any]]:
    params = {
        "q": item.get("title") or "",
        "limit": str(SEARCH_LIMIT),
        "sfw": "true",
    }
    url = f"{API}/{search_endpoint(item)}?{urllib.parse.urlencode(params)}"
    data = get_json(url)
    return data.get("data") or []


def titles_of(media: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for key in ("title", "title_english", "title_japanese"):
        if media.get(key):
            values.append(str(media[key]))
    for entry in media.get("titles") or []:
        title = entry.get("title") if isinstance(entry, dict) else None
        if title:
            values.append(str(title))
    for title in media.get("title_synonyms") or []:
        if title:
            values.append(str(title))
    # preserve order / de-duplicate
    return list(dict.fromkeys(values))


def title_similarity(query: str, candidate: str) -> float:
    q, c = norm(query), norm(candidate)
    if not q or not c:
        return 0.0
    if q == c:
        return 1.0
    if q in c or c in q:
        shorter, longer = min(len(q), len(c)), max(len(q), len(c))
        return 0.90 + 0.07 * (shorter / max(1, longer))
    return difflib.SequenceMatcher(None, q, c).ratio()


def candidate_year(media: dict[str, Any], endpoint: str) -> int | None:
    direct = media.get("year")
    if isinstance(direct, int):
        return direct
    block = media.get("aired") if endpoint == "anime" else media.get("published")
    try:
        value = (((block or {}).get("prop") or {}).get("from") or {}).get("year")
        return int(value) if value else None
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
    if fmt == "novel" or medium == "novel":
        return 0.09 if typ in {"light novel", "novel"} else -0.05
    if medium == "manga":
        return 0.06 if typ in {"manga", "one shot", "oneshot"} else 0.0
    return 0.0


def candidate_score(item: dict[str, Any], media: dict[str, Any]) -> float:
    title_score = max((title_similarity(item.get("title", ""), x) for x in titles_of(media)), default=0.0)
    score = title_score + medium_bonus(item, media)
    iy = item.get("year")
    cy = candidate_year(media, search_endpoint(item))
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
    ranked = sorted(((candidate_score(item, m), m) for m in results), key=lambda x: x[0], reverse=True)
    if not ranked:
        return None, 0.0
    score, media = ranked[0]
    # A deliberately modest threshold handles localized/alternate titles while
    # rejecting clearly unrelated search results.
    if score < 0.64:
        return None, score
    return media, score


def get_name_list(media: dict[str, Any], *keys: str) -> list[str]:
    values: list[str] = []
    for key in keys:
        for entry in media.get(key) or []:
            if isinstance(entry, dict) and entry.get("name"):
                values.append(str(entry["name"]))
    return list(dict.fromkeys(values))


def get_people_list(media: dict[str, Any], key: str) -> list[str]:
    values: list[str] = []
    for entry in media.get(key) or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if name:
            values.append(str(name))
    return list(dict.fromkeys(values))


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


def apply_media(item: dict[str, Any], media: dict[str, Any], match: float) -> None:
    endpoint = search_endpoint(item)
    native = media.get("title_japanese") or ""
    canonical = media.get("title_english") or media.get("title") or item.get("title") or ""
    romaji = media.get("title") or ""
    cover = image_url(media)

    score = media.get("score")
    score_100 = int(round(float(score) * 10)) if isinstance(score, (int, float)) else item.get("score")

    synopsis = (media.get("synopsis") or "").strip()
    background = (media.get("background") or "").strip()
    year = candidate_year(media, endpoint) or item.get("year")
    source_tags = get_name_list(media, "genres", "themes", "demographics", "explicit_genres")

    item["jikanId"] = media.get("mal_id")
    item["malId"] = media.get("mal_id")
    item["sourceName"] = "MyAnimeList (via Jikan)"
    item["sourceUrl"] = media.get("url") or item.get("sourceUrl") or ""
    item["canonicalTitle"] = canonical
    item["romajiTitle"] = romaji
    item["nativeTitle"] = native or item.get("nativeTitle") or ""
    item["cover"] = cover or item.get("cover") or ""
    item["description"] = synopsis or background or item.get("description") or ""
    item["score"] = score_100
    # Jikan/MAL's `members` is a useful popularity count; `popularity` itself is a rank.
    item["popularity"] = media.get("members") if media.get("members") is not None else item.get("popularity")
    item["favourites"] = media.get("favorites") if media.get("favorites") is not None else item.get("favourites")
    item["episodes"] = media.get("episodes") if endpoint == "anime" else item.get("episodes")
    item["chapters"] = media.get("chapters") if endpoint == "manga" else item.get("chapters")
    item["volumes"] = media.get("volumes") if endpoint == "manga" else item.get("volumes")
    item["sourceStatus"] = media.get("status") or ""
    item["status"] = map_status(media.get("status"), item.get("status"))
    item["sourceFormat"] = media.get("type") or ""
    item["year"] = year
    item["genres"] = get_name_list(media, "genres")
    item["sourceTags"] = [{"name": name, "rank": None} for name in source_tags[:14]]
    item["rank"] = media.get("rank")
    item["malPopularityRank"] = media.get("popularity")
    item["scoredBy"] = media.get("scored_by")
    item["matchConfidence"] = round(match, 3)

    if endpoint == "anime":
        item["studios"] = get_people_list(media, "studios")
        item["producers"] = get_people_list(media, "producers")[:8]
        trailer = (media.get("trailer") or {}).get("url") if isinstance(media.get("trailer"), dict) else None
        links = [{"site": "MyAnimeList", "url": item["sourceUrl"], "type": "INFO"}] if item["sourceUrl"] else []
        if trailer:
            links.append({"site": "Trailer", "url": trailer, "type": "VIDEO"})
        item["externalLinks"] = links
    else:
        authors: list[str] = []
        for author in media.get("authors") or []:
            if isinstance(author, dict) and author.get("name"):
                authors.append(str(author["name"]))
        item["authors"] = list(dict.fromkeys(authors))
        item["externalLinks"] = (
            [{"site": "MyAnimeList", "url": item["sourceUrl"], "type": "INFO"}]
            if item["sourceUrl"]
            else []
        )

    item["lastSynced"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> int:
    if not CATALOG_PATH.exists():
        print(f"ERROR: missing {CATALOG_PATH}", file=sys.stderr)
        return 2

    catalog = json.loads(CATALOG_PATH.read_text("utf-8"))
    if not isinstance(catalog, list):
        print("ERROR: catalog.json must contain a JSON array", file=sys.stderr)
        return 2

    print(f"RebornRank/Jikan: enriching {len(catalog)} catalogue entries")
    found = 0
    unresolved = 0
    request_failures = 0

    for idx, item in enumerate(catalog, start=1):
        title = item.get("title") or item.get("id") or f"item-{idx}"
        print(f"[{idx:03d}/{len(catalog):03d}] {title}")
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
            f"{item.get('score') if item.get('score') is not None else 'no score'}"
        )

    CATALOG_PATH.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    covers = sum(1 for x in catalog if x.get("cover"))
    descriptions = sum(1 for x in catalog if x.get("description"))
    print("\n=== RebornRank catalogue sync summary ===")
    print(f"Enriched this run : {found}")
    print(f"Unresolved        : {unresolved}")
    print(f"Request failures  : {request_failures}")
    print(f"Covers in catalog : {covers}/{len(catalog)}")
    print(f"Descriptions      : {descriptions}/{len(catalog)}")

    # Do not show a misleading green workflow if the source was entirely blocked.
    if found == 0:
        print("ERROR: Jikan enriched 0 entries; refusing to report success.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
