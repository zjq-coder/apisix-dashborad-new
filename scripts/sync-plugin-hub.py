"""Sync the Apache APISIX Chinese Plugin Hub. Run with --check to verify a snapshot."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen
from xml.etree import ElementTree


SITE = "https://apisix.apache.org"
HUB = "/zh/plugins/"
ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "web/public/plugin-icons"
MANIFEST = ROOT / "web/src/data/plugin-hub.json"


def fetch(path):
    request = Request(SITE + path, headers={"User-Agent": "APISIX-Dashboard-Catalog/1.0"})
    with urlopen(request, timeout=30) as response:
        return response.read()


class PluginHub(HTMLParser):
    def __init__(self):
        super().__init__()
        self.groups = []
        self.plugin = None
        self.heading = False
        self.sprite = None
        self.advertised = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "section" and attrs.get("data-testid") == "plugin-group":
            color = re.search(r"--group-color:(#[0-9a-fA-F]{6})\b", attrs["style"])
            self.groups.append({"name": "", "color": color[1], "plugins": {}})
        elif tag == "h2" and self.groups and not self.groups[-1]["name"]:
            self.heading = True
        elif tag == "a" and attrs.get("data-testid") == "plugin-card":
            self.plugin = attrs["data-plugin"]
            if not re.fullmatch(r"[a-z0-9-]+", self.plugin):
                raise ValueError(f"Unexpected plugin ID {self.plugin}")
            if attrs["href"] != f"/zh/docs/apisix/plugins/{self.plugin}/":
                raise ValueError(f"Review changed documentation URL for {self.plugin}")
            self.groups[-1]["plugins"][self.plugin] = None
        elif self.plugin and tag in ("use", "img"):
            ref = attrs["href"] if tag == "use" else attrs["src"]
            if re.fullmatch(r"#icon[a-z0-9-]+", ref):
                icon = f"symbols/{ref[1:]}.svg"
            elif re.fullmatch(r"/img/(plugin|integrations)/[a-zA-Z0-9_.-]+\.svg", ref):
                icon = ref.lstrip("/")
            else:
                raise ValueError(f"Unknown icon source {ref}")
            self.groups[-1]["plugins"][self.plugin] = icon
        elif tag == "script" and attrs.get("src") == "/js/plugin-icon.js":
            self.sprite = attrs["src"]

    def handle_endtag(self, tag):
        if tag == "a":
            self.plugin = None
        if tag == "h2":
            self.heading = False

    def handle_data(self, data):
        if self.heading:
            self.groups[-1]["name"] += data.strip()
        if '"numberOfItems"' in data:
            for item in json.loads(data):
                if item.get("@type") == "CollectionPage":
                    self.advertised = item["mainEntity"]["numberOfItems"]


def snapshot():
    hub = PluginHub()
    hub.feed(fetch(HUB).decode("utf-8"))
    entries = [item for group in hub.groups for item in group["plugins"].items()]
    if (not entries or len(entries) != hub.advertised or
            len(set(name for name, _ in entries)) != len(entries) or
            any(not icon for _, icon in entries) or not all(g["name"] for g in hub.groups)):
        raise ValueError("Incomplete plugin catalog")
    source = fetch(hub.sprite).decode("utf-8")
    symbols = {m[1]: (m[2], m[3]) for m in re.finditer(
        r'<symbol id="([^"]+)"([^>]*)>(.*?)</symbol>', source, re.DOTALL)}
    icons = sorted(set(icon for _, icon in entries))

    def artwork(icon):
        if icon.startswith("symbols/"):
            attrs, shape = symbols[Path(icon).stem]
            content = (f'<svg xmlns="http://www.w3.org/2000/svg" '
                       f'xmlns:xlink="http://www.w3.org/1999/xlink"{attrs}>{shape}</svg>\n').encode()
        else:
            content = fetch("/" + icon)
        if ElementTree.fromstring(content).tag != "{http://www.w3.org/2000/svg}svg":
            raise ValueError(f"Invalid SVG for {icon}")
        return ICONS / icon, content

    with ThreadPoolExecutor(max_workers=5) as pool:
        files = dict(pool.map(artwork, icons))
    license_text = source.split("/*", 1)[1].split("*/", 1)[0]
    if "MIT License" not in license_text:
        raise ValueError("Review updated icon license")
    files[ICONS / "symbols/LICENSE.txt"] = (
        "\n".join(line.lstrip(" *") for line in license_text.splitlines()).strip() + "\n"
    ).encode()
    files[MANIFEST] = (json.dumps(hub.groups, ensure_ascii=False, indent=2) + "\n").encode()
    return files, len(hub.groups), len(entries), len(icons)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files, groups, entries, icons = snapshot()
    for path, content in files.items():
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise SystemExit(f"Snapshot differs: {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    print(f"{groups} categories, {entries} plugins, {icons} distinct icons verified.")
