#!/usr/bin/env python3
"""Build a JetBrains Mono that carries the Herdr agent-icon glyphs.

Terminal.app has one font per profile and no fallback setting, so the
qintmb.herdr-icon-agent-ui plugin's private-use glyphs (U+E1A0-U+E1B0) render
as boxes there. This script copies them into a JetBrains Mono Regular, maps U+2B24
(the plugin's LED glyph, which JetBrains Mono lacks and macOS otherwise draws
too wide, swallowing the space after it) to the cell-sized ● outline, and installs the result as one family you pick in
Terminal > Settings > Profiles > Text. Ghostty can use the same font.

  scripts/patch-terminal-font.py                # download JetBrains Mono, write ~/Library/Fonts
  scripts/patch-terminal-font.py --jbm path/to/JetBrainsMono-Regular.ttf --out ./x.ttf

fontTools is fetched into a temporary directory when it is not importable.
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HOME = os.path.expanduser("~")
ICON_GLOB = os.path.join(HOME, ".config/herdr/plugins/*/qintmb.herdr-icon-agent-ui*/dist/HerdrAgentIconsMax-Regular.ttf")
JBM_RELEASES = "https://api.github.com/repos/JetBrains/JetBrainsMono/releases/latest"
LED, LED_SOURCE = 0x2B24, 0x25CF   # ⬤ is drawn with the cell-sized ● outline


def ensure_fonttools(tmp: str):
    try:
        import fontTools  # noqa: F401
        return
    except ImportError:
        pass
    print("fetching fontTools into a temporary directory")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--target", tmp, "fonttools"], check=True)
    sys.path.insert(0, tmp)


def download_jbm(tmp: str) -> str:
    with urllib.request.urlopen(JBM_RELEASES, timeout=30) as r:
        release = json.load(r)
    url = next(a["browser_download_url"] for a in release["assets"] if a["name"].endswith(".zip"))
    print("downloading", url)
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = next(n for n in z.namelist() if n.endswith("ttf/JetBrainsMono-Regular.ttf"))
        z.extract(member, tmp)
    return os.path.join(tmp, member), release["tag_name"]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--icon-font", help=f"plugin TTF (default: first match of {ICON_GLOB})")
    p.add_argument("--jbm", help="JetBrainsMono-Regular.ttf (default: latest GitHub release)")
    p.add_argument("--out", default=os.path.join(HOME, "Library/Fonts/JetBrainsMonoHerdr-Regular.ttf"))
    p.add_argument("--family", default="JetBrains Mono Herdr")
    a = p.parse_args()

    icon = a.icon_font or next(iter(sorted(glob.glob(ICON_GLOB))), None)
    if not icon or not os.path.exists(icon):
        print("icon font not found; install the plugin first or pass --icon-font", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        ensure_fonttools(tmp)
        from fontTools.ttLib import TTFont
        jbm, version = (a.jbm, "local") if a.jbm else download_jbm(tmp)
        base, icons = TTFont(jbm), TTFont(icon)
        if base["head"].unitsPerEm != icons["head"].unitsPerEm:
            print("units-per-em differ; the plugin font is built for JetBrains Mono metrics", file=sys.stderr)
            return 1
        glyf, hmtx, order = base["glyf"], base["hmtx"], base.getGlyphOrder()
        unicode_tables = [t for t in base["cmap"].tables if t.isUnicode()]
        base_cmap = base.getBestCmap()
        added = []

        def add(name: str, cp: int, glyph, metrics):
            glyf.glyphs[name] = glyph
            hmtx.metrics[name] = metrics
            order.append(name)
            for t in unicode_tables:
                t.cmap[cp] = name
            added.append(cp)

        for cp, gname in sorted(icons.getBestCmap().items()):
            if icons["glyf"][gname].isComposite():
                print(f"skipping composite glyph {gname}", file=sys.stderr)
                continue
            add(f"herdr.{cp:04X}", cp, icons["glyf"][gname], icons["hmtx"][gname])
        if LED not in base_cmap and LED_SOURCE in base_cmap:
            for t in unicode_tables:
                t.cmap[LED] = base_cmap[LED_SOURCE]
            added.append(LED)

        base.setGlyphOrder(order)
        base["maxp"].numGlyphs = len(order)
        if base["post"].formatType == 2.0:
            base["post"].extraNames, base["post"].mapping = [], {}
        ps = a.family.replace(" ", "") + "-Regular"
        for r in base["name"].names:
            if r.nameID in (1, 16):
                r.string = a.family
            elif r.nameID == 4:
                r.string = a.family + " Regular"
            elif r.nameID == 6:
                r.string = ps
            elif r.nameID == 3:
                r.string = f"{version};{ps}"
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        base.save(a.out)
    print(f"wrote {a.out}: {len(added)} glyphs added ({', '.join(f'U+{c:04X}' for c in added)})")
    print(f"family '{a.family}', PostScript '{ps}'. If it is not offered yet, open it once in Font Book:")
    print(f"  open '{a.out}'")
    print("Terminal.app: Settings > Profiles > Text > Font, or")
    print(f"  osascript -e 'tell application \"Terminal\" to set font name of settings set \"<profile>\" to \"{ps}\"'")
    print(f"Ghostty: font-family = \"{a.family}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
