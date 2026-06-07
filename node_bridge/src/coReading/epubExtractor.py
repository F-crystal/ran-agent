#!/usr/bin/env python3
"""Small EPUB text extractor for co_reading imports.

Uses only Python stdlib so the Node bridge does not need a ZIP/XML dependency.
"""

from __future__ import annotations

import html
import json
import posixpath
import re
import sys
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET


def text_from_html(raw: bytes) -> tuple[str, str]:
    source = raw.decode("utf-8", errors="replace")
    source = re.sub(r"(?is)<(script|style).*?</\1>", " ", source)
    heading_match = re.search(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>", source)
    title = clean_tags(heading_match.group(1)) if heading_match else ""
    source = re.sub(r"(?i)<br\s*/?>", "\n", source)
    source = re.sub(r"(?i)</(p|div|section|article|h[1-6]|li)>", "\n", source)
    text = clean_tags(source)
    return title, text


def clean_tags(value: str) -> str:
    value = re.sub(r"(?s)<[^>]+>", " ", value)
    value = html.unescape(value)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n\s+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def find_opf_path(zf: zipfile.ZipFile) -> str:
    try:
        raw = zf.read("META-INF/container.xml")
        root = ET.fromstring(raw)
        for item in root.iter():
            full_path = item.attrib.get("full-path")
            if full_path:
                return full_path
    except Exception:
        pass
    for name in zf.namelist():
        if name.lower().endswith(".opf"):
            return name
    raise RuntimeError("EPUB OPF file not found")


def parse_opf(zf: zipfile.ZipFile, opf_path: str) -> tuple[str, str, list[str]]:
    raw = zf.read(opf_path)
    root = ET.fromstring(raw)
    manifest: dict[str, str] = {}
    spine_ids: list[str] = []
    title = ""
    author = ""
    for item in root.iter():
        tag = item.tag.rsplit("}", 1)[-1]
        if tag == "title" and not title:
            title = (item.text or "").strip()
        elif tag == "creator" and not author:
            author = (item.text or "").strip()
        elif tag == "item":
            item_id = item.attrib.get("id")
            href = item.attrib.get("href")
            if item_id and href:
                manifest[item_id] = href
        elif tag == "itemref":
            idref = item.attrib.get("idref")
            if idref:
                spine_ids.append(idref)
    base = str(PurePosixPath(opf_path).parent)
    if base == ".":
        base = ""
    spine_paths = []
    for idref in spine_ids:
        href = manifest.get(idref)
        if href:
            spine_paths.append(posixpath.normpath(posixpath.join(base, href)))
    return title, author, spine_paths


def extract(path: str) -> dict[str, object]:
    with zipfile.ZipFile(path) as zf:
        opf_path = find_opf_path(zf)
        title, author, spine_paths = parse_opf(zf, opf_path)
        if not spine_paths:
            spine_paths = [
                name for name in zf.namelist()
                if name.lower().endswith((".xhtml", ".html", ".htm"))
            ]
        sections = []
        for index, name in enumerate(spine_paths):
            try:
                heading, text = text_from_html(zf.read(name))
            except KeyError:
                continue
            if text:
                sections.append({
                    "title": heading or f"Section {index + 1}",
                    "sourcePath": name,
                    "text": text,
                })
        return {"title": title, "author": author, "sections": sections}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: epubExtractor.py <book.epub>", file=sys.stderr)
        return 2
    print(json.dumps(extract(argv[1]), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
