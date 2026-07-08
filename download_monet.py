"""
Скачивает все картины Клода Моне с wikiart.org в папку paintings рядом с Desktop.
"""

import html as html_mod
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup

LIST_URL = "https://www.wikiart.org/en/claude-monet/all-works/text-list"
DESKTOP = os.path.expanduser("~/Desktop")
OUTPUT_DIR = os.path.join(DESKTOP, "paintings")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
MAX_WORKERS = 8
RETRIES = 3
DELAY_BETWEEN = 0.3  # seconds between requests


def get_slugs():
    """Парсит список всех картин и возвращает список (slug, title)."""
    print(f"Fetching list: {LIST_URL}")
    r = requests.get(LIST_URL, headers=HEADERS, timeout=30)
    soup = BeautifulSoup(r.text, "html.parser")
    links = soup.select("ul.painting-list-text li a")
    slugs = []
    for a in links:
        href = a.get("href", "")
        if "/en/claude-monet/" in href:
            slug = href.split("/en/claude-monet/")[-1]
            title = a.get_text(strip=True)
            slugs.append((slug, title))
    print(f"Found {len(slugs)} paintings in list")
    return slugs


def get_image_url(slug):
    """По странице картины находит URL оригинала."""
    url = f"https://www.wikiart.org/en/claude-monet/{slug}"
    for attempt in range(RETRIES):
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
            m = re.search(r"paintingJson = (\{[^>]+?\})\">", r.text)
            if m:
                raw = html_mod.unescape(m.group(1))
                img_m = re.search(r'"image" : "([^"]+)"', raw)
                if img_m:
                    return img_m.group(1)
            return None
        except Exception as e:
            if attempt < RETRIES - 1:
                time.sleep(2)
            else:
                print(f"  FAIL [{slug}]: {e}")
                return None
    return None


def download_image(img_url, filepath):
    """Скачивает одно изображение."""
    if os.path.exists(filepath):
        return "EXISTS"
    for attempt in range(RETRIES):
        try:
            r = requests.get(img_url, headers=HEADERS, timeout=60)
            if r.status_code == 200:
                os.makedirs(os.path.dirname(filepath), exist_ok=True)
                with open(filepath, "wb") as f:
                    f.write(r.content)
                return "OK"
            else:
                if attempt < RETRIES - 1:
                    time.sleep(2)
                else:
                    return f"HTTP {r.status_code}"
        except Exception as e:
            if attempt < RETRIES - 1:
                time.sleep(2)
            else:
                return f"ERR: {e}"


def slug_to_filename(slug):
    """Преобразует slug в безопасное имя файла."""
    return slug + ".jpg"


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"Output: {OUTPUT_DIR}")

    # Шаг 1: получить все slug-и
    paintings = get_slugs()
    if not paintings:
        print("No paintings found!")
        return

    # Шаг 2: собрать image URL для каждой картины
    print(f"\nStep 1: Fetching image URLs for {len(paintings)} paintings...")
    image_map = {}  # slug -> image_url
    failed_slugs = []

    # Сначала проверяем сохранённый прогресс
    progress_file = os.path.join(OUTPUT_DIR, "_urls.txt")
    if os.path.exists(progress_file):
        with open(progress_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "|" in line:
                    slug, url = line.split("|", 1)
                    image_map[slug] = url
        print(f"  Loaded {len(image_map)} URLs from previous run")

    remaining = [(s, t) for s, t in paintings if s not in image_map]
    print(f"  Need to fetch: {len(remaining)}")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {}
        for slug, title in remaining:
            futures[pool.submit(get_image_url, slug)] = (slug, title)

        for i, future in enumerate(as_completed(futures)):
            slug, title = futures[future]
            img_url = future.result()
            if img_url:
                image_map[slug] = img_url
            else:
                failed_slugs.append(slug)
            if (i + 1) % 50 == 0:
                pct = (len(image_map) + i + 1) * 100 // len(paintings)
                print(f"  Progress: {len(image_map)}/{len(paintings)} ({pct}%)")
            time.sleep(DELAY_BETWEEN)

    # Сохраняем URLs
    with open(progress_file, "w", encoding="utf-8") as f:
        for slug, url in sorted(image_map.items()):
            f.write(f"{slug}|{url}\n")

    print(f"\nImage URLs collected: {len(image_map)}, failed: {len(failed_slugs)}")

    # Шаг 3: скачать все изображения
    print(f"\nStep 2: Downloading {len(image_map)} images...")
    downloaded = 0
    skipped = 0
    errors = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {}
        for slug, img_url in image_map.items():
            filename = slug_to_filename(slug)
            filepath = os.path.join(OUTPUT_DIR, filename)
            if os.path.exists(filepath):
                skipped += 1
                continue
            futures[pool.submit(download_image, img_url, filepath)] = slug

        for i, future in enumerate(as_completed(futures)):
            slug = futures[future]
            result = future.result()
            if result == "OK":
                downloaded += 1
            elif result == "EXISTS":
                skipped += 1
            else:
                errors += 1
                print(f"  ERROR [{slug}]: {result}")
            if (downloaded + skipped + errors) % 50 == 0:
                print(
                    f"  Downloaded: {downloaded}, skipped: {skipped}, errors: {errors}"
                )
            time.sleep(0.1)

    print(f"\nDone! Downloaded: {downloaded}, skipped: {skipped}, errors: {errors}")
    print(f"Files in: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
