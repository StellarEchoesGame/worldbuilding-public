"""Checks that the manifest-driven assembler reproduces the committed reference outputs byte for byte."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class AssembleReferenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copy2(HERE.parent / "BOOK.md", self.tmp / "BOOK.md")
        self.ref = self.tmp / "reference"
        shutil.copytree(HERE, self.ref, ignore=shutil.ignore_patterns("__pycache__"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_script(self, *args):
        return subprocess.run([sys.executable, str(self.ref / "assemble_reference.py"), *args],
                              capture_output=True, text=True, check=False)

    def test_manifest_reproduces_committed_outputs(self):
        (self.ref / "REFERENCE.md").unlink()
        (self.ref / "hashes.json").unlink()
        result = self.run_script("--revision", "8.1")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("REFERENCE.md", "hashes.json"):
            self.assertEqual((self.ref / name).read_bytes(), (HERE / name).read_bytes(), name)

    def test_wrong_revision_writes_nothing(self):
        (self.ref / "REFERENCE.md").unlink()
        (self.ref / "hashes.json").unlink()
        result = self.run_script("--revision", "8.2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match manifest revision 8.1", result.stderr)
        self.assertFalse((self.ref / "REFERENCE.md").exists())
        self.assertFalse((self.ref / "hashes.json").exists())


if __name__ == "__main__":
    unittest.main()
