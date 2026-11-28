"""Build a deterministic Debian/Ubuntu .deb package for VideoSave using pure Python (no dpkg-deb needed)."""

import argparse
import gzip
import io
import json
from pathlib import Path
import tarfile
from tempfile import NamedTemporaryFile

from build_release import ROOT, EXECUTABLE_SCRIPTS, package_entries, release_version


def ar_member(name: str, payload: bytes) -> bytes:
    header = (
        f"{name:<16}"
        f"{0:<12}"
        f"{0:<6}"
        f"{0:<6}"
        f"{'100644':<8}"
        f"{len(payload):<10}"
        "`\n"
    ).encode("ascii")
    assert len(header) == 60
    pad = b"\n" if len(payload) % 2 else b""
    return header + payload + pad


def make_tar_gz(entries: dict[str, tuple[bytes, int]]) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
            for name, (content, mode) in sorted(entries.items()):
                info = tarfile.TarInfo(name=name)
                info.size = len(content)
                info.mtime = 0
                info.uid = 0
                info.gid = 0
                info.uname = "root"
                info.gname = "root"
                info.mode = mode
                tar.addfile(info, io.BytesIO(content))
    return buf.getvalue()


def build_deb(dist_dir: Path) -> Path:
    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    version = release_version(manifest)
    name = f"VideoSave-{version}"
    unix_entries = package_entries(manifest)[f"{name}-unix.tar.gz"]

    data_files: dict[str, tuple[bytes, int]] = {}
    total_bytes = 0
    for arc_path, content in unix_entries.items():
        rel = arc_path.split("/", 1)[1]
        mode = 0o755 if rel in EXECUTABLE_SCRIPTS else 0o644
        data_files[f"./opt/videosave/{rel}"] = (content, mode)
        total_bytes += len(content)

    # Standard CLI wrappers in /usr/bin/
    wrappers = {
        "./usr/bin/videosave": "#!/usr/bin/env bash\nexec /opt/videosave/tools/start-unix.sh \"$@\"\n",
        "./usr/bin/videosave-cli": "#!/usr/bin/env bash\nexec /opt/videosave/tools/start-unix.sh --run-cli \"$@\"\n",
        "./usr/bin/videosave-mcp": "#!/usr/bin/env bash\nexec /opt/videosave/tools/start-unix.sh --run-mcp \"$@\"\n",
    }
    for path_key, script in wrappers.items():
        b = script.encode("utf-8")
        data_files[path_key] = (b, 0o755)
        total_bytes += len(b)

    desktop_entry = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=VideoSave\n"
        "Comment=Local-first media downloader, management center, and MCP server\n"
        "Exec=/usr/bin/videosave\n"
        "Terminal=true\n"
        "Categories=Network;AudioVideo;\n"
    ).encode("utf-8")
    data_files["./usr/share/applications/videosave.desktop"] = (desktop_entry, 0o644)
    total_bytes += len(desktop_entry)

    installed_kb = max(1, (total_bytes + 1023) // 1024)
    control_text = (
        "Package: videosave\n"
        f"Version: {version}\n"
        "Section: video\n"
        "Priority: optional\n"
        "Architecture: all\n"
        f"Installed-Size: {installed_kb}\n"
        "Depends: bash, curl, ca-certificates\n"
        "Recommends: ffmpeg\n"
        "Maintainer: VideoSave Contributors <https://github.com/KaiserIIII/videosave>\n"
        "Homepage: https://kaiseriiii.github.io/videosave/\n"
        "Description: Local-first media downloader, browser companion, and native MCP server\n"
        " VideoSave provides multi-connection resumable HLS/DASH/HTTP downloads,\n"
        " an authenticated local management console (/console), and 27 native MCP tools.\n"
        " Automatically bootstraps verified Node.js 24 LTS if not installed on the system.\n"
    ).encode("utf-8")

    control_tar = make_tar_gz({"./control": (control_text, 0o644)})
    data_tar = make_tar_gz(data_files)
    deb_bytes = b"!<arch>\n" + ar_member("debian-binary", b"2.0\n") + ar_member("control.tar.gz", control_tar) + ar_member("data.tar.gz", data_tar)

    dist_dir.mkdir(parents=True, exist_ok=True)
    out = dist_dir / f"videosave_{version}_all.deb"
    with NamedTemporaryFile(dir=dist_dir, delete=False) as tmp:
        staged = Path(tmp.name)
    try:
        staged.write_bytes(deb_bytes)
        staged.replace(out)
    finally:
        staged.unlink(missing_ok=True)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    out = build_deb(parser.parse_args().dist)
    print(out.name)


if __name__ == "__main__":
    main()
