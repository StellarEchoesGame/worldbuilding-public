"""Assemble the authoring manuscript. This is not a game generator."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parent
CHAPTERS = [
    "01-universe.md", "02-civilizations.md", "03-war-and-departure.md",
    "04-life-and-people.md", "05-voyage-and-play.md", "06-continuity-and-map.md",
]
HEADER = """# 群星回响：把家带向群星

世界观 revision 8 · 2026-09-24 · WB-R8

这是本轮对已经选定方向的统一修订，取代自然长耀期开场、初名归航号和必定在息壤建城的旧主线。它是世界观与创作基线，不宣称游戏、美术或工程已实现；线上 Wiki 的版本须另行核实发布。

**一艘被战争迫使离港的家园舰，先使生活延续，再主动接回他人，最后带着自己选择的使命驶向未知。**

六章依次说明宇宙规则、文明关系、战争与启航、舰上生活、玩家航程，以及保持历史一致的作者约束。
"""

def assemble():
    sections = []
    chapters = {}
    for name in CHAPTERS:
        raw = (ROOT / name).read_bytes()
        chapters[name] = hashlib.sha256(raw).hexdigest()
        lines = raw.decode("utf-8").splitlines()
        sections.append("\n".join("#" + line if line.startswith("#") else line for line in lines))
    book = HEADER.rstrip() + "\n\n" + "\n\n---\n\n".join(sections) + "\n"
    (ROOT / "BOOK.md").write_text(book, encoding="utf-8")
    record = {"revision": 8, "chapters": chapters,
              "book_sha256": hashlib.sha256(book.encode("utf-8")).hexdigest()}
    (ROOT / "manuscript-hashes.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(record, ensure_ascii=False))

if __name__ == "__main__":
    assemble()
