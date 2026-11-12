"""Update offline field help from Apache APISIX documentation (pip install beautifulsoup4)."""

import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web/src/data"
CACHE = ROOT / ".local/plugins-audit/docs"


def read_page(name, locale, refresh):
    cache = CACHE / (name + ".html" if locale == "zh" else name + ".en.html")
    if refresh or not cache.exists():
        prefix = "/zh" if locale == "zh" else ""
        url = "https://apisix.apache.org" + prefix + "/docs/apisix/plugins/" + name + "/"
        for attempt in range(3):
            try:
                with urlopen(Request(url, headers={"User-Agent": "APISIX-Dashboard-Docs/1"}), timeout=30) as res:
                    html = res.read()
                if b"<article" not in html:
                    raise ValueError("Missing documentation article: " + name)
                cache.write_bytes(html)
                break
            except OSError:
                if attempt == 2:
                    raise
    return BeautifulSoup(cache.read_text(encoding="utf8"), "html.parser").article


def extract(name, locale, refresh):
    article = read_page(name, locale, refresh)
    heading = next((h for h in article.select("h2") if re.search(r"描述|简介|介绍|description|overview", h.get_text(strip=True), re.I)), None)
    overview = []
    if heading:
        for element in heading.find_all_next(["p", "h2", "h3"]):
            if element.name != "p" or len(overview) == 2:
                break
            overview.append(" ".join(element.stripped_strings))
    fields = {}
    for table in article.select("table"):
        rows = table.select("tr")
        if not rows:
            continue
        columns = [cell.get_text(strip=True).lower() for cell in rows[0].select("th")]
        description = next((i for i, h in enumerate(columns) if h in ("描述", "说明", "description")), None)
        if description is None or columns[0] not in ("名称", "名字", "参数", "属性", "字段", "name", "field", "参数名", "属性名称"):
            continue
        heading = table.find_previous(["h2", "h3", "h4"])
        section = heading.get_text(strip=True).lower() if heading else ""
        introduction = table.find_previous(["p", "h2", "h3", "h4"])
        caption = introduction.get_text(" ", strip=True).lower() if introduction and introduction.name == "p" else ""
        scope_text = section + (" " + caption if len(caption) < 120 else "")
        scope = "consumer" if re.search(r"consumer|消费者|credential|凭据|凭证", scope_text) else "route"
        if any(s in section for s in ("metadata", "元数据", "静态", "plugin_attr")):
            continue
        for row in rows[1:]:
            cells = row.find_all("td", recursive=False)
            if len(cells) <= description:
                continue
            field = cells[0].get_text(strip=True)
            if not re.fullmatch(r"[a-z_][\w.\[\]-]*", field):
                continue
            help_text = " ".join(cells[description].stripped_strings).strip()
            if help_text:
                fields.setdefault(scope, {}).setdefault(field, help_text)
    examples = [{"title": h.get_text(strip=True).rstrip("\u200b"), "anchor": h["id"]}
                for h in article.select("h2[id],h3[id]")
                if h.name == "h3" and h.find_previous("h2")
                and re.search(r"示例|例子|example|用法|使用|场景", h.find_previous("h2").get_text(), re.I)]
    return name, {"overview": overview, "fields": fields, "examples": examples}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Fetch fresh documentation even if cached")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    names = [name for group in json.loads((DATA / "plugin-hub.json").read_text(encoding="utf8"))
             for name in group["plugins"]]
    names.extend(json.loads((DATA / "plugin-doc-extensions.json").read_text(encoding="utf8")))
    for locale, file in [("zh", "plugin-guides.json"), ("en", "plugin-guides.en.json")]:
        with ThreadPoolExecutor(max_workers=6) as pool:
            guides = dict(pool.map(partial(extract, locale=locale, refresh=args.refresh), names))
        (DATA / file).write_text(json.dumps(guides, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        print(f"{locale}: {len(guides)} plugin documents, {sum(len(fields) for g in guides.values() for fields in g['fields'].values())} field notes")
