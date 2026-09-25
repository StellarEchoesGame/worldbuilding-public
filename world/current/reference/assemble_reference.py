"""Assemble existing reference entries without creating world facts."""
from pathlib import Path
import argparse
import hashlib
import json

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "manifest.json"


def load_manifest(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    revision, header, files = data.get("revision"), data.get("header"), data.get("files")
    if not isinstance(revision, str) or not revision:
        raise SystemExit(f"{path.name}: 'revision' must be a non-empty string")
    if not isinstance(header, list) or not all(isinstance(line, str) for line in header):
        raise SystemExit(f"{path.name}: 'header' must be a list of lines")
    if (not isinstance(files, list) or not files or len(set(files)) != len(files)
            or not all(isinstance(name, str) and name == Path(name).name and name.endswith(".md")
                       and name != "REFERENCE.md" for name in files)):
        raise SystemExit(f"{path.name}: 'files' must list unique source .md names in this directory")
    return revision, "\n".join(header), files


def assemble(expected_revision=None):
    revision, header, files = load_manifest(MANIFEST)
    if expected_revision is not None and expected_revision != revision:
        raise SystemExit(f"--revision {expected_revision} does not match manifest revision {revision}")
    parts = []
    documents = {}
    for name in files:
        raw = (ROOT / name).read_bytes()
        documents[name] = hashlib.sha256(raw).hexdigest()
        parts.append("\n".join("#" + line if line.startswith("#") else line
                               for line in raw.decode("utf-8").splitlines()))
    book = header.rstrip() + "\n\n" + "\n\n---\n\n".join(parts) + "\n"
    base_book_sha256 = hashlib.sha256((ROOT.parent / "BOOK.md").read_bytes()).hexdigest()
    (ROOT / "REFERENCE.md").write_text(book, encoding="utf-8")
    result = {"base_book_sha256": base_book_sha256,
              "reference_revision": revision, "documents": documents,
              "reference_book_sha256": hashlib.sha256(book.encode("utf-8")).hexdigest()}
    (ROOT / "hashes.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"reference_book_sha256": result["reference_book_sha256"], "characters": len(book)}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", help="refuse to write unless manifest.json declares this revision")
    assemble(parser.parse_args().revision)
