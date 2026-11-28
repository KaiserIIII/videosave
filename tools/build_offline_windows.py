"""Build a complete self-contained Windows x64 Offline Portable ZIP bundling pinned Node.js, FFmpeg, FFprobe, and yt-dlp."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from build_release import ROOT, installer_components, package_entries, release_version


def sha256_file(path: Path) -> str:
    h = sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_verified_download(url: str, expected_sha: str, dest: Path) -> Path:
    if dest.is_file() and sha256_file(dest) == expected_sha:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["curl.exe", "--fail", "--location", "--silent", "--show-error", "--retry", "2",
         "--connect-timeout", "20", "--max-time", "300", "--output", str(dest), url],
        check=True,
    )
    actual = sha256_file(dest)
    if actual != expected_sha:
        dest.unlink(missing_ok=True)
        raise ValueError(f"SHA-256 mismatch for {dest.name}: expected {expected_sha}, got {actual}")
    return dest


def build_offline_windows(dist_dir: Path, cache_dir: Path) -> Path:
    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    version = release_version(manifest)
    name = f"VideoSave-{version}"
    offline_name = f"{name}-win-x64-offline"
    base_entries = package_entries(manifest)[f"{name}.zip"]
    components = {c["name"]: c for c in installer_components()}

    with TemporaryDirectory(prefix="videosave-offline-build-") as td:
        work = Path(td)
        tools_stage = work / ".local-tools"
        tools_stage.mkdir(parents=True, exist_ok=True)

        # 1. Node.js 24.22.3 win-x64
        node_ref = next(r for r in components["Node.js"]["externalReferences"] if r["type"] == "distribution")
        node_archive = ensure_verified_download(node_ref["url"], node_ref["hashes"][0]["content"], cache_dir / Path(node_ref["url"]).name)
        subprocess.run(["tar.exe", "-xf", str(node_archive), "-C", str(tools_stage)], check=True)
        node_dir = tools_stage / f"node-v{components['Node.js']['version']}-win-x64"
        if not (node_dir / "node.exe").is_file():
            raise FileNotFoundError(f"Missing node.exe after extracting {node_archive}")

        # 2. FFmpeg 8.1.2 essentials build
        ff_ref = next(r for r in components["FFmpeg"]["externalReferences"] if r["type"] == "distribution")
        ff_archive = ensure_verified_download(ff_ref["url"], ff_ref["hashes"][0]["content"], cache_dir / Path(ff_ref["url"]).name)
        subprocess.run(["tar.exe", "-xf", str(ff_archive), "-C", str(tools_stage)], check=True)
        ff_dir = tools_stage / f"ffmpeg-{components['FFmpeg']['version']}-essentials_build"
        if not (ff_dir / "bin" / "ffmpeg.exe").is_file():
            raise FileNotFoundError(f"Missing ffmpeg.exe after extracting {ff_archive}")

        # 3. yt-dlp pinned standalone exe
        yt_ref = next(r for r in components["yt-dlp"]["externalReferences"] if r["type"] == "distribution")
        yt_exe = ensure_verified_download(yt_ref["url"], yt_ref["hashes"][0]["content"], cache_dir / f"yt-dlp-{components['yt-dlp']['version']}.exe")
        shutil.copy2(yt_exe, tools_stage / "yt-dlp.exe")

        # Keep only required binaries & licenses inside .local-tools so offline bundle stays lean and clean
        offline_entries = {}
        for arc_path, data in base_entries.items():
            rel = arc_path.split("/", 1)[1]
            offline_entries[f"{offline_name}/{rel}"] = data

        include_tool_files = [
            (node_dir / "node.exe", f".local-tools/{node_dir.name}/node.exe"),
            (node_dir / "LICENSE", f".local-tools/{node_dir.name}/LICENSE"),
            (ff_dir / "bin" / "ffmpeg.exe", f".local-tools/{ff_dir.name}/bin/ffmpeg.exe"),
            (ff_dir / "bin" / "ffprobe.exe", f".local-tools/{ff_dir.name}/bin/ffprobe.exe"),
            (ff_dir / "LICENSE", f".local-tools/{ff_dir.name}/LICENSE"),
            (tools_stage / "yt-dlp.exe", ".local-tools/yt-dlp.exe"),
        ]
        for src, rel in include_tool_files:
            if src.is_file():
                offline_entries[f"{offline_name}/{rel}"] = src.read_bytes()

        offline_meta = json.dumps({
            "bundle": "win-x64-offline",
            "version": version,
            "bundledComponents": {
                "node": components["Node.js"]["version"],
                "ffmpeg": components["FFmpeg"]["version"],
                "yt-dlp": components["yt-dlp"]["version"],
            },
            "offlineReady": True,
        }, indent=2).encode("utf-8") + b"\n"
        offline_entries[f"{offline_name}/.local-tools/offline-manifest.json"] = offline_meta

        dist_dir.mkdir(parents=True, exist_ok=True)
        out_zip = dist_dir / f"{offline_name}.zip"
        with ZipFile(out_zip, "w") as zf:
            for key, content in sorted(offline_entries.items()):
                info = ZipInfo(key)
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                zf.writestr(info, content, compress_type=ZIP_DEFLATED)
    return out_zip


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--cache", type=Path, default=ROOT / ".ots" / "offline-cache")
    out = build_offline_windows(parser.parse_args().dist, parser.parse_args().cache)
    print(f"{sha256_file(out)}  {out.name}")


if __name__ == "__main__":
    main()
