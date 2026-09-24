"""Assemble existing reference entries without creating world facts."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parent
FILES = [
    "01-space-and-history.md", "02-technology-and-infrastructure.md",
    "03-government-and-economy.md", "04-war-and-diplomacy.md",
    "05-ecology-and-everyday.md", "06-culture-and-contact.md",
    "07-register-and-creation.md", "08-cross-system-cases.md",
]
HEADER = """# 群星回响 · 世界设定参考集 8.1

2026-09-24 · WB-D1 / #31

本文由八组参考条目组成：空间历史、科技设施、治理经济、战争外交、生态日常、文化接触、事实索引、交叉演算。沿用revision 8共同底稿，以可查阅的世界运作规则深化，而非按人物经历排列的小说。

创作事实、条件实例和有边界的未知在条目中分别标明。新科技及生理细节为本作虚构选择；文字一致性通过不代表工程、临床或游戏体验已经验证。Git与Wiki发布状态见任务记录。
"""

def assemble():
    parts = []
    documents = {}
    for name in FILES:
        raw = (ROOT / name).read_bytes()
        documents[name] = hashlib.sha256(raw).hexdigest()
        parts.append("\n".join("#" + line if line.startswith("#") else line
                               for line in raw.decode("utf-8").splitlines()))
    book = HEADER.rstrip() + "\n\n" + "\n\n---\n\n".join(parts) + "\n"
    (ROOT / "REFERENCE.md").write_text(book, encoding="utf-8")
    result = {"base_book_sha256": hashlib.sha256((ROOT.parent / "BOOK.md").read_bytes()).hexdigest(),
              "reference_revision": "8.1", "documents": documents,
              "reference_book_sha256": hashlib.sha256(book.encode("utf-8")).hexdigest()}
    (ROOT / "hashes.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"reference_book_sha256": result["reference_book_sha256"], "characters": len(book)}))

if __name__ == "__main__":
    assemble()
