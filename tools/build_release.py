"""Build the desktop and Android developer ZIPs from the VideoSave source tree."""

from hashlib import sha256
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist"
EXTENSION = ROOT / "extension"


def read_entries(directory, pattern):
    return {file.relative_to(directory).as_posix(): file.read_bytes()
            for file in directory.glob(pattern) if file.is_file()}


def write_package(name, entries):
    destination = OUTPUT / name
    with NamedTemporaryFile(dir=OUTPUT, delete=False) as temporary:
        staged = Path(temporary.name)
    try:
        with ZipFile(staged, "w") as archive:
            for name, content in sorted(entries.items()):
                entry = ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, content, compress_type=ZIP_DEFLATED)
        staged.replace(destination)
    finally:
        staged.unlink(missing_ok=True)
    return destination


def main():
    manifest_path = EXTENSION / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    name = f"VideoSave-{manifest['version']}"
    extension_files = {
        **read_entries(EXTENSION, "*.mjs"),
        **read_entries(EXTENSION, "*.html"),
        **read_entries(EXTENSION, "*.css"),
        **read_entries(EXTENSION, "icons/*.png"),
        "manifest.json": manifest_path.read_bytes(),
    }
    docs = ["LICENSE", "README.md", "README.zh-CN.md", "docs/videosave-panel.png"]
    desktop_files = {file: (ROOT / file).read_bytes() for file in docs}
    desktop_files.update({"extension/" + file: data for file, data in extension_files.items()})
    desktop_files.update(read_entries(ROOT, "tools/*.mjs"))
    for file in ("Start VideoSave.cmd", "tools/start-windows.ps1"):
        desktop_files[file] = (ROOT / file).read_bytes()

    manifest["permissions"].remove("downloads")
    manifest["permissions"].remove("offscreen")
    manifest["background"].pop("service_worker")
    android_files = {
        **extension_files,
        "manifest.json": (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        "LICENSE": desktop_files["LICENSE"],
    }

    OUTPUT.mkdir(exist_ok=True)
    desktop = write_package(name + ".zip", {f"{name}/{file}": data for file, data in desktop_files.items()})
    android = write_package(name + "-android-dev.zip", android_files)
    checksums = [f"{sha256(file.read_bytes()).hexdigest()}  {file.name}" for file in (desktop, android)]
    (OUTPUT / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="ascii")
    for file in (desktop, android):
        print(file.relative_to(ROOT).as_posix())


if __name__ == "__main__":
    main()
