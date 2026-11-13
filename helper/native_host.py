"""One bounded request per Chrome Native Messaging connection."""
import base64
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import zipfile

from file_helper import LIMIT, build, describe, output_name, verified_file

REQUEST_LIMIT = 8 * 1024 * 1024
CHUNK = 256 * 1024


def downloaded_file(root, value, name, nonce, limit):
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", nonce):
        raise ValueError("Недопустимый идентификатор загрузки.")
    expected = root / nonce / name
    candidate = Path(value)
    if not candidate.is_absolute() or candidate != expected or candidate.name != name:
        raise ValueError("Chrome сохранил файл вне рабочей папки CourseraQueue или под другим именем.")
    for path in (root, expected.parent, expected):
        if getattr(path.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT or path.is_symlink():
            raise ValueError("Рабочая папка и файл должны быть обычными путями Windows.")
    if expected.resolve(strict=True) != expected or not expected.is_file() or expected.stat().st_nlink != 1:
        raise ValueError("Скачанный файл не найден в рабочей папке.")
    with expected.open("rb") as handle:
        data = handle.read(limit + 1)
    return data


def process(request, config):
    action = request["action"]
    if action == "describe":
        return {"spec": describe(request)}
    if action == "build":
        return build(request, config.get("chrome"))
    if action == "course-source":
        name = output_name(request["name"])
        data = downloaded_file(Path(config["workdir"]), request["path"], name, request["nonce"], LIMIT)
        if not 0 < len(data) <= LIMIT:
            raise ValueError("Исходный файл пуст или превышает допустимый размер.")
        return {"size": len(data), "mime": mimetypes.guess_type(name)[0] or "application/octet-stream",
                "base64": base64.b64encode(data).decode("ascii")}
    if action != "attachment":
        raise ValueError("Неизвестная операция.")
    spec = describe(request)
    name = output_name(request["name"])
    if "path" in request:
        data = downloaded_file(Path(config["workdir"]), request["path"], name, request["nonce"], spec["maxBytes"])
    else:
        encoded = request["base64"]
        if not isinstance(encoded, str) or len(encoded) > 4 * ((LIMIT + 2) // 3):
            raise ValueError("Превышен размер вложения.")
        data = base64.b64decode(encoded, validate=True)
    return verified_file(name, data, spec)


def send(message):
    data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def main():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        origin, config_path = sys.argv[1:3]
        config = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
        if origin.rstrip("/") != config["origin"]:
            raise ValueError("Расширение не указано в настройках помощника.")
        header = sys.stdin.buffer.read(4)
        if len(header) != 4:
            return
        length, = struct.unpack("<I", header)
        if not 0 < length <= REQUEST_LIMIT:
            raise ValueError("Недопустимый объём запроса.")
        result = process(json.loads(sys.stdin.buffer.read(length)), config)
        encoded = result.pop("base64", "")
        for offset in range(0, len(encoded), CHUNK):
            send({"chunk": encoded[offset:offset + CHUNK]})
        send({"result": result})
    except SyntaxError as error:
        send({"error": f"Ошибка синтаксиса Python в строке {error.lineno}."})
    except (KeyError, TypeError, ValueError, OSError, OverflowError, zipfile.BadZipFile, RuntimeError, subprocess.SubprocessError) as error:
        send({"error": str(error)[:300]})


if __name__ == "__main__":
    main()
