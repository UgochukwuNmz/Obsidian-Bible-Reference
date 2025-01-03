#!/usr/bin/env python3
# bible_parser.py

import sys
import re
import requests
from bs4 import BeautifulSoup

DEFAULT_VERSION = "NKJV"
FETCH_READ_TIMEOUT = 10
FETCH_OPEN_TIMEOUT = 30


def fetch_html(reference, version=DEFAULT_VERSION, filename=None, verbose=False):
    """
    Fetches the raw HTML for a chapter from Bible Gateway or a local file.
    """
    if filename:
        if verbose:
            print(f"Reading from local file: {filename}")
        with open(filename, encoding="utf-8") as file:
            return file.read()
    else:
        url = "https://www.biblegateway.com/passage/"
        params = {"search": reference, "version": version, "interface": "print"}
        if verbose:
            print(f"Fetching {url} with params: {params}")
        try:
            response = requests.get(url, params=params, timeout=(FETCH_OPEN_TIMEOUT, FETCH_READ_TIMEOUT))
            response.raise_for_status()
            return response.text
        except requests.RequestException as error:
            sys.exit(f"Error fetching data: {error}")


def clean_text(html):
    """
    Cleans and formats the passage text.
    """
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup.find_all("sup"):
        tag.decompose()
    for tag in soup.find_all("span", class_="chapternum"):
        tag.decompose()
    for tag in soup.find_all(["i", "em"]):
        tag.replace_with(f"*{tag.get_text()}*")

    text = soup.get_text()
    return re.sub(r"\s{2,}", " ", text).strip()


def parse_chapter(html, verbose=False):
    """
    Parses HTML and extracts structured chapter data.
    """
    soup = BeautifulSoup(html, "html.parser")
    elements = []
    first_verse_found = False

    for element in soup.select(".passage-content .text, h3 .text"):
        if element.name == "span" and element.parent.name == "h3":
            elements.append({"type": "subtitle", "text": clean_text(str(element))})
        else:
            verse_tag = element.select_one(".versenum")
            cleaned_text = clean_text(str(element))

            if verse_tag:
                verse_number = verse_tag.get_text(strip=True)
                verse_content = re.sub(f"^{re.escape(verse_number)}", "", cleaned_text).strip()
                elements.append({"type": "verse", "verse_number": verse_number, "text": verse_content})
                first_verse_found = True
            elif not first_verse_found:
                elements.append({"type": "verse", "verse_number": "1", "text": cleaned_text.strip()})
                first_verse_found = True
            else:
                if elements and elements[-1]["type"] == "verse":
                    elements[-1]["text"] += f" {cleaned_text}"

    if verbose:
        print("== Parsed Chapter ==")
        for elem in elements:
            label = "Subtitle" if elem["type"] == "subtitle" else f"Verse {elem['verse_number']}"
            print(f"{label}: {elem['text'][:40]}...")

    return elements


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Fetch and parse a Bible chapter.")
    parser.add_argument("reference", help="Bible chapter reference (e.g., 'John 1')")
    parser.add_argument("-v", "--version", default=DEFAULT_VERSION, help="Bible version (default: NKJV)")
    parser.add_argument("-i", "--verbose", action="store_true", help="Enable verbose output")
    parser.add_argument("-f", "--file", dest="filename", help="Read from a local file")
    args = parser.parse_args()

    html_content = fetch_html(args.reference, version=args.version, filename=args.filename, verbose=args.verbose)
    chapter_data = parse_chapter(html_content, verbose=args.verbose)

    for item in chapter_data:
        prefix = "SUBTITLE:" if item["type"] == "subtitle" else f"VERSE {item['verse_number']}:"
        print(f"{prefix} {item['text']}")
