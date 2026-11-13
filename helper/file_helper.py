"""File validation and generation. Generated programs are compiled for syntax only."""
import argparse
import base64
import html
import io
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import tempfile
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LIMIT = 4 * 1024 * 1024
TYPES = {
    ".py": "text/x-python", ".pdf": "application/pdf", ".zip": "application/zip",
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
    ".json": "application/json", ".html": "text/html",
}
ZIP_MEMBER_EXTENSIONS = (TYPES.keys() - {".zip"}) | {".c", ".h", ".csc", ".xml"}
NAME = re.compile(r"[\w][\w .()-]{0,118}\.[\w]{1,10}", re.UNICODE)
SIZE = r"(\d+(?:[.,]\d+)?)\s*(bytes?|kib|mib|kb|mb|байт(?:а|ов)?|кб|мб)\b"
UNITS = {"kb": 1000, "mb": 1000000, "kib": 1024, "mib": 1048576, "кб": 1000, "мб": 1000000}


def windows_chrome():
    for root in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                 os.environ.get("LOCALAPPDATA")):
        if root:
            exe = Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe"
            if exe.is_file():
                return str(exe)
    return shutil.which("chrome") or shutil.which("chromium")


def output_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value) or ".." in value:
        raise ValueError("Недопустимое имя файла.")
    if value.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(
        prefix + str(i) for prefix in ("COM", "LPT") for i in range(1, 10)
    )}:
        raise ValueError("Имя файла зарезервировано в Windows.")
    return value


def text_bytes(content, name):
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Пустой файл или отсутствует текст.")
    extension = Path(name).suffix.lower()
    if extension == ".py":
        compile(content, name, "exec")
        coding = re.search(r"coding[:=]\s*([-\w.]+)", "\n".join(content.splitlines()[:2]))
        if coding and coding[1].lower() not in {"utf-8", "utf8"}:
            raise ValueError("Исходник Python должен объявлять UTF-8.")
    if extension == ".json":
        json.loads(content)
    return content.encode("utf-8")


def pdf_bytes(content, chrome):
    if not chrome:
        raise ValueError("Chrome не найден. Передайте путь с помощью --chrome.")
    data = text_bytes(content, "document.txt")
    if len(data) > 180_000:
        raise ValueError("Текст PDF превышает лимит локального генератора.")
    with tempfile.TemporaryDirectory(prefix="coursera-pdf-") as temp:
        root = Path(temp)
        page = root / "document.html"
        output = root / "document.pdf"
        page.write_text(
            "<!doctype html><meta charset=utf-8><style>@page{margin:19mm}"
            "body{font:12pt/1.5 'Segoe UI',sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}"
            "</style><body>" + html.escape(content) + "</body>", encoding="utf-8"
        )
        result = subprocess.run([
            chrome, "--headless", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-background-networking",
            "--user-data-dir=" + str(root / "profile"), "--no-pdf-header-footer",
            "--print-to-pdf=" + str(output), page.as_uri()
        ], capture_output=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode or not output.is_file():
            raise ValueError("Chrome не создал PDF.")
        return output.read_bytes()


def zip_bytes(entries, chrome):
    if not isinstance(entries, list) or not 1 <= len(entries) <= 32:
        raise ValueError("ZIP должен содержать от 1 до 32 файлов.")
    names = set()
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            raw = entry["name"]
            if not isinstance(raw, str) or len(raw) > 160 or "\\" in raw or ":" in raw:
                raise ValueError("Недопустимый путь внутри ZIP.")
            parts = raw.split("/")
            if not all(re.fullmatch(r"[\w][\w .()-]*", part) and ".." not in part and not part.endswith((" ", ".")) for part in parts):
                raise ValueError("Недопустимый путь внутри ZIP.")
            name = str(PurePosixPath(raw))
            if parts[-1] != "Makefile":
                output_name(parts[-1])
            if name.casefold() in names:
                raise ValueError("Имена файлов в ZIP повторяются.")
            names.add(name.casefold())
            ext = Path(name).suffix.lower()
            if parts[-1] != "Makefile" and ext not in ZIP_MEMBER_EXTENSIONS:
                raise ValueError("Неподдерживаемый формат внутри ZIP.")
            data = pdf_bytes(entry["content"], chrome) if ext == ".pdf" else text_bytes(entry["content"], name)
            archive.writestr(name, data)
    return result.getvalue()


def required_zip_names(requirements):
    names = []
    required_lines = re.findall(
        r"(?:zip (?:must|should) (?:include|contain)|archive (?:must|should) (?:include|contain)|в архив(?:е)? (?:должны быть|включите))[^\n]*",
        requirements, re.I
    )
    for line in required_lines:
        required = re.findall(r"[\w/-]+\.(?:py|pdf|txt|md|csv|json|html|csc|c|h|xml)\b|(?:[\w-]+/)*\bMakefile\b", line, re.I)
        if not required:
            raise ValueError("Состав ZIP описан без распознаваемых имён файлов.")
        names.extend(required)
    return list(dict.fromkeys(names))



def describe(payload):
    question = payload["question"]
    requirements = "\n".join((question.get("requirements", ""), payload.get("instructions", "")))
    accept = {kind.strip().lower() for kind in question.get("accept", "").split(",") if kind.strip()}
    direct_ext = set(re.findall(
        r"(?:upload|submit|загрузите|отправьте)\s+(?:an? |the )?(?:file (?:in |as )?)?\.?([a-z0-9]+)(?=\s|[,.;]|$)",
        requirements, re.I
    ))
    constrained = {"." + kind.lower() for kind in direct_ext if "." + kind.lower() in TYPES}
    mentioned = {ext for ext in TYPES if re.search(re.escape(ext) + r"\b", requirements, re.I)}
    name_rule = r"(?:name (?:the |your )?file|file ?name|save as|file (?:must|should) be (?:named|called)|назовите файл|имя файла)"
    fixed = set()
    for rule in re.finditer(name_rule + r"\s*(?:must be|должно быть|[:=])?\s*", requirements, re.I):
        candidate = re.match(r"""(?:"([^"\n]+)"|'([^'\n]+)'|«([^»\n]+)»|`([^`\n]+)`|([\w.-]+\.[a-z0-9]+))""", requirements[rule.end():], re.I)
        if candidate:
            fixed.add(output_name(next(value for value in candidate.groups() if value)))
    if not fixed:
        for match in re.finditer(r"(?:submit|upload|attach|загрузите|прикрепите)\s+(?:the |file |файл )?[`'\"«]?([\w.-]+\.(?:py|pdf|zip|txt|md|csv|json|html))\b", requirements, re.I):
            fixed.add(output_name(match[1]))
    if len(fixed) > 1:
        raise ValueError("На форме указаны разные имена файла: " + ", ".join(sorted(fixed)))
    if re.search(r"provided (?:dataset|data file)|download (?:the )?(?:dataset|starter files?)|use (?:your )?(?:measured|recorded) (?:data|results)|фактические результаты эксперимента|предоставленн\w+ набор данных", requirements, re.I):
        raise ValueError("Требуются исходные данные или результаты измерений.")
    exact = next(iter(fixed), None)
    allowed = set(TYPES)
    if exact:
        allowed &= {Path(exact).suffix.lower()}
    if accept:
        allowed = {ext for ext in allowed if ext in accept or accept.intersection({
            TYPES[ext], mimetypes.guess_type("file" + ext)[0], TYPES[ext].split("/")[0] + "/*",
            *({".py": {"text/plain", "application/x-python"}, ".zip": {"application/x-zip-compressed"}}.get(ext, set()))
        })}
    if constrained:
        allowed &= constrained
    elif not accept and not exact:
        allowed &= mentioned
    if not allowed:
        raise ValueError("На форме не распознан допустимый поддерживаемый формат файла.")
    upper = [int(float(n.replace(",", ".")) * UNITS.get(unit.lower(), 1)) for n, unit in re.findall(
        r"(?:max(?:imum)?(?: (?:file )?size)?|file size limit|up to|no (?:more|larger) than|не более|максимум)\s*[:=]?\s*" + SIZE, requirements, re.I
    )]
    lower = [int(float(n.replace(",", ".")) * UNITS.get(unit.lower(), 1)) for n, unit in re.findall(
        r"(?:min(?:imum)?(?: file size)?|at least|не менее)\s*[:=]?\s*" + SIZE, requirements, re.I
    )]
    minimum, maximum = max([1, *lower]), min([LIMIT, *upper])
    if minimum > maximum:
        raise ValueError("Требуемый размер файла превышает лимит помощника.")
    suggested = exact or ("submission" + next(iter(allowed)) if len(allowed) == 1 else None)
    return {"exactName": exact, "suggestedName": suggested, "extensions": sorted(allowed), "minBytes": minimum,
            "maxBytes": maximum, "requirements": requirements,
            "zipEntries": required_zip_names(requirements) if ".zip" in allowed else []}


def validate_pdf(data):
    tail = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", data)
    if not data.startswith(b"%PDF-") or not tail:
        raise ValueError("PDF не прошёл структурную проверку.")
    offset = int(tail[1])
    section = data[offset:offset + 8192]
    if not section.startswith(b"xref") and not (
        re.match(rb"\d+\s+\d+\s+obj\b", section) and re.search(rb"/Type\s*/XRef\b", section)
    ):
        raise ValueError("PDF содержит некорректную таблицу ссылок.")
    info = shutil.which("pdfinfo")
    if not info:
        return
    result = subprocess.run([info, "-"], input=data, capture_output=True, timeout=4,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise ValueError("PDF не открывается в Poppler.")


def validate_zip(data, required):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = [entry for entry in archive.infolist() if not entry.is_dir()]
        if not 1 <= len(files) <= 32 or sum(entry.file_size for entry in files) > 4 * LIMIT:
            raise ValueError("Недопустимый объём распакованного ZIP.")
        names = set()
        for entry in archive.infolist():
            name = entry.filename.rstrip("/")
            parts = name.split("/")
            if not all(re.fullmatch(r"[\w][\w .()-]*", part) and ".." not in part and not part.endswith((" ", ".")) for part in parts):
                raise ValueError("Недопустимый путь внутри ZIP.")
            if (entry.external_attr >> 16) & 0o170000 == 0o120000 or entry.flag_bits & 1:
                raise ValueError("ZIP содержит ссылку или зашифрованный файл.")
            if not entry.is_dir():
                if name.casefold() in names:
                    raise ValueError("Имена файлов в ZIP повторяются.")
                names.add(name.casefold())
        if archive.testzip():
            raise ValueError("ZIP не прошёл проверку контрольной суммы.")
        if not {name.casefold() for name in required} <= names:
            raise ValueError("В ZIP отсутствуют обязательные файлы.")


def verified_file(name, data, spec):
    name = output_name(name)
    extension = Path(name).suffix.lower()
    if spec["exactName"] and name != spec["exactName"]:
        raise ValueError("Ожидалось точное имя файла " + spec["exactName"] + ".")
    if extension not in spec["extensions"]:
        raise ValueError("Формат файла отличается от требований Coursera.")
    if not spec["minBytes"] <= len(data) <= spec["maxBytes"]:
        raise ValueError("Размер файла выходит за допустимые границы.")
    if extension == ".pdf":
        validate_pdf(data)
    elif extension == ".zip":
        validate_zip(data, spec["zipEntries"])
    else:
        text_bytes(data.decode("utf-8-sig"), name)
    return {"name": name, "mime": TYPES[extension], "size": len(data),
            "base64": base64.b64encode(data).decode("ascii")}


def build(payload, chrome=None):
    file = payload["file"]
    spec = describe(payload)
    name = output_name(file["name"])
    extension = Path(name).suffix.lower()
    if spec["exactName"] and name != spec["exactName"]:
        raise ValueError("Ожидалось точное имя файла " + spec["exactName"] + ".")
    if extension not in spec["extensions"]:
        raise ValueError("Формат файла отличается от требований Coursera.")
    if extension == ".pdf":
        data = pdf_bytes(file["content"], chrome or windows_chrome())
    elif extension == ".zip":
        data = zip_bytes(file.get("entries"), chrome or windows_chrome())
    else:
        data = text_bytes(file["content"], name)
    return verified_file(name, data, spec)
