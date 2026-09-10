#!/usr/bin/env python3
"""Enrich RebornRank's local catalogue from AniList, then save static metadata.

The public site never needs to call AniList: this script is intended for GitHub
Actions (or a local machine) and writes catalog.json into the repository.
"""
from __future__ import annotations

import difflib
import html
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalog.json"
API = "https://graphql.anilist.co"
BATCH = 8
REQUEST_GAP = 2.2
TIMEOUT = 30

FIELDS = r"""
id
siteUrl
type
format
status
episodes
chapters
volumes
countryOfOrigin
averageScore
popularity
favourites
startDate { year month day }
title { romaji english native }
coverImage { extraLarge large medium color }
bannerImage
description(asHtml:false)
genres
tags { name rank isMediaSpoiler isGeneralSpoiler }
externalLinks { site url type }
"""


def norm(value: str | None) -> str:
    s = unicodedata.normalize("NFKD", value or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def match_score(query: str, media: dict) -> float:
    q = norm(query)
    choices = [media.get("title", {}).get(k) or "" for k in ("english", "romaji", "native")]
    scores = []
    for title in choices:
        n = norm(title)
        if not n:
            continue
        if q == n:
            scores.append(1.0)
        elif q in n or n in q:
            scores.append(0.92)
        else:
            scores.append(difflib.SequenceMatcher(None, q, n).ratio())
    return max(scores or [0.0])


def post_graphql(query: str, variables: dict, tries: int = 4) -> dict:
    payload = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "RebornRank-catalog-sync/1.0 (+https://rebornrank.pages.dev)",
    }
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(API, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
                data = json.loads(response.read().decode("utf-8"))
            if data.get("errors"):
                raise RuntimeError(data["errors"][0].get("message", "AniList GraphQL error"))
            return data.get("data") or {}
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 429:
                retry = int(exc.headers.get("Retry-After") or 8)
                time.sleep(min(30, max(4, retry)))
                continue
            if 500 <= exc.code < 600:
                time.sleep(4 * (attempt + 1))
                continue
            raise
        except Exception as exc:  # network/transient
            last = exc
            time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"AniList unavailable after retries: {last}")


def batch_query(items: list[dict]) -> tuple[str, dict]:
    defs = []
    aliases = []
    variables = {}
    for i, item in enumerate(items):
        defs.extend([f"$q{i}:String!", f"$t{i}:MediaType!"])
        variables[f"q{i}"] = item["title"]
        variables[f"t{i}"] = "ANIME" if item.get("kind") == "ANIME" else "MANGA"
        aliases.append(f"m{i}: Media(search:$q{i}, type:$t{i}) {{ {FIELDS} }}")
    query = "query(" + ",".join(defs) + "){\n" + "\n".join(aliases) + "\n}"
    return query, variables


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = html.unescape(value)
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def apply_media(item: dict, media: dict) -> bool:
    score = match_score(item.get("title", ""), media)
    if score < 0.52:
        print(f"  ! match rejected ({score:.2f}): {item.get('title')} -> {media.get('title')}")
        return False

    title = media.get("title") or {}
    cover = media.get("coverImage") or {}
    start = media.get("startDate") or {}
    tags = [
        t for t in (media.get("tags") or [])
        if not t.get("isMediaSpoiler") and not t.get("isGeneralSpoiler")
    ]
    tags.sort(key=lambda x: x.get("rank") or 0, reverse=True)

    item["anilistId"] = media.get("id")
    item["sourceName"] = "AniList"
    item["sourceUrl"] = media.get("siteUrl") or item.get("sourceUrl") or ""
    item["canonicalTitle"] = title.get("english") or title.get("romaji") or item.get("title")
    item["romajiTitle"] = title.get("romaji") or ""
    item["nativeTitle"] = title.get("native") or item.get("nativeTitle") or ""
    item["cover"] = cover.get("extraLarge") or cover.get("large") or cover.get("medium") or item.get("cover") or ""
    item["coverColor"] = cover.get("color") or ""
    item["banner"] = media.get("bannerImage") or ""
    item["description"] = clean_text(media.get("description")) or item.get("description") or ""
    item["score"] = media.get("averageScore")
    item["popularity"] = media.get("popularity")
    item["favourites"] = media.get("favourites")
    item["episodes"] = media.get("episodes")
    item["chapters"] = media.get("chapters")
    item["volumes"] = media.get("volumes")
    item["sourceStatus"] = media.get("status") or ""
    item["sourceFormat"] = media.get("format") or ""
    item["year"] = start.get("year") or item.get("year")
    item["genres"] = media.get("genres") or []
    item["sourceTags"] = [{"name": t.get("name"), "rank": t.get("rank")} for t in tags[:12]]
    item["externalLinks"] = [
        {"site": x.get("site"), "url": x.get("url"), "type": x.get("type")}
        for x in (media.get("externalLinks") or [])
        if x.get("site") and x.get("url")
    ][:10]
    item["lastSynced"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return True


def main() -> int:
    if not CATALOG_PATH.exists():
        print(f"Missing {CATALOG_PATH}", file=sys.stderr)
        return 2
    catalog = json.loads(CATALOG_PATH.read_text("utf-8"))
    print(f"RebornRank: enriching {len(catalog)} catalogue entries")
    found = 0
    missing = 0

    for start in range(0, len(catalog), BATCH):
        batch = catalog[start:start + BATCH]
        query, variables = batch_query(batch)
        try:
            data = post_graphql(query, variables)
        except Exception as exc:
            print(f"Batch {start // BATCH + 1} failed: {exc}")
            missing += len(batch)
            time.sleep(REQUEST_GAP)
            continue
        for i, item in enumerate(batch):
            media = data.get(f"m{i}")
            if media and apply_media(item, media):
                found += 1
                cover_state = "cover" if item.get("cover") else "no-cover"
                print(f"  + {item.get('title')} [{cover_state}]")
            else:
                missing += 1
                print(f"  - unresolved: {item.get('title')}")
        time.sleep(REQUEST_GAP)

    CATALOG_PATH.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Done: {found} enriched, {missing} unresolved. Static catalogue saved to catalog.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
