import base64
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

from helper.file_helper import build, windows_chrome


def make(name, content=None, entries=None, instructions="", accept=""):
    return build({
        "file": {"name": name, "content": content, "entries": entries},
        "question": {"accept": accept, "requirements": ""},
        "instructions": instructions,
    })


class FilesTest(unittest.TestCase):
    def test_python_validation(self):
        result = make("solution.py", 'print("Привет")\n', accept=".py", instructions="Filename: solution.py. Maximum file size: 1 KB.")
        self.assertEqual(result["size"], len(base64.b64decode(result["base64"])))
        with self.assertRaises(SyntaxError):
            make("solution.py", "def bad(", accept=".py")
        with self.assertRaises(ValueError):
            make("wrong.py", "pass", accept=".py", instructions="Filename: solution.py")
        self.assertEqual(make("My Work.py", "pass", accept=".py",
                              instructions='The file must be named "My Work.py".')["name"], "My Work.py")
        with self.assertRaises(ValueError):
            make("solution.py", "pass", accept=".py", instructions="Maximum file size: 3 bytes")
        with self.assertRaises(ValueError):
            make("solution.py", "pass", accept=".py", instructions="Use your measured results.")

    def test_zip_entries(self):
        rule = "ZIP must contain solution.py and readme.txt."
        entries = [{"name": "solution.py", "content": "pass"}, {"name": "readme.txt", "content": "Read me"}]
        result = make("work.zip", entries=entries, accept=".zip", instructions=rule)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["base64"]))) as archive:
            self.assertEqual(archive.namelist(), ["solution.py", "readme.txt"])
            self.assertIsNone(archive.testzip())
        with self.assertRaises(ValueError):
            make("work.zip", entries=entries[:1], accept=".zip", instructions=rule)
        with self.assertRaises(ValueError):
            make("work.zip", entries=[{"name": "../secret.py", "content": "pass"}], accept=".zip")

    def test_project_zip_contains_c_sources_and_simulator_configuration(self):
        names = ["project/main.c", "project/Makefile", "project/test.csc"]
        entries = [{"name": name, "content": "fixture\n"} for name in names]
        rule = "ZIP must contain project/main.c, project/Makefile and project/test.csc."
        result = make("project.zip", entries=entries, accept=".zip", instructions=rule)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["base64"]))) as archive:
            self.assertEqual(archive.namelist(), names)
        with self.assertRaises(ValueError):
            make("project.zip", entries=entries[:-1], accept=".zip", instructions=rule)

    @unittest.skipUnless(windows_chrome(), "Chrome unavailable")
    def test_pdf_opens(self):
        result = make("report.pdf", "PDF fixture\nТекст на русском", accept=".pdf")
        data = base64.b64decode(result["base64"])
        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))

    def test_native_host_reads_only_the_matching_download_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            work = root / "CourseraQueue"
            nonce = "11111111-1111-1111-1111-111111111111"
            (work / nonce).mkdir(parents=True)
            file = work / nonce / "submission.py"
            outside = root / "submission.py"
            content = b"def work():\n    return True\n"
            file.write_bytes(content)
            outside.write_bytes(content)
            config = root / "config.json"
            origin = "chrome-extension://" + "a" * 32
            config.write_text(json.dumps({"workdir": str(work), "origin": origin}), encoding="utf-8")

            def request(path):
                payload = json.dumps({
                    "action": "attachment", "name": file.name, "nonce": nonce, "path": str(path),
                    "question": {"accept": ".py", "requirements": "Filename: submission.py"}
                }).encode("utf-8")
                command = [sys.executable, "-B", "helper/native_host.py", origin, str(config)]
                frames = io.BytesIO(subprocess.run(command, check=True, capture_output=True,
                                                  input=struct.pack("<I", len(payload)) + payload).stdout)
                messages = []
                while prefix := frames.read(4):
                    length, = struct.unpack("<I", prefix)
                    messages.append(json.loads(frames.read(length)))
                return messages

            frames = request(file)
            self.assertEqual(base64.b64decode(frames[0]["chunk"]), content)
            self.assertEqual(frames[-1]["result"]["name"], file.name)
            self.assertIn("error", request(outside)[0])


if __name__ == "__main__":
    unittest.main()
