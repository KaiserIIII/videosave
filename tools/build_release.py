"""Build deterministic VideoSave release archives (ZIP + Unix tar.gz) and a CycloneDX SBOM."""

import argparse
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import re
import tarfile
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
RELEASE_DOCS = (
    "LICENSE", "README.md", "README.zh-CN.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md",
    "docs/logo.svg",
    "docs/videosave-0.9-detection.png", "docs/videosave-0.9-settings.png", "docs/videosave-mcp-control.png",
    "docs/architecture.md", "docs/compatibility-report.zh-CN.md", "docs/competitive-review.zh-CN.md",
    "docs/detection-research.zh-CN.md", "docs/privacy.md", "docs/mcp.md", "docs/install.md",
    "docs/dsh-guide.md", "docs/dsh-guide.zh-CN.md", "docs/dsh-feedback-tracker.md",
    "docs/ai-recipes.md", "docs/ai-recipes.zh-CN.md", "docs/third-party-notices.md", "docs/faq.md",
    "docs/launch-kit.md", "docs/hls-benchmark.zh-CN.md", "docs/v1-security.md",
    "docs/android-harmonyos.md", "docs/security-audit-v1.2.md", "docs/security-audit-v1.3.md", "docs/security-audit-v1.3.1.md", "docs/roadmap.md",
    "tests/benchmark-hls.mjs", "tests/dash-public.mjs",
)
EXECUTABLE_SCRIPTS = frozenset({
    "tools/start-unix.sh",
    "tools/mcp-server.mjs",
    "tools/media-cli.mjs",
    "tools/server.mjs",
    "tools/upgrade-dsh.mjs",
    "Launch VideoSave.command",
    "Uninstall VideoSave.command",
})
PROJECT = "https://github.com/KaiserIIII/videosave"


LF_EXTS = frozenset({".mjs", ".js", ".json", ".md", ".html", ".css", ".svg", ".sh", ".command", ".txt", ".yml", ".yaml"})
CRLF_EXTS = frozenset({".cmd", ".ps1"})


def normalize_entry_bytes(rel_path: str, data: bytes) -> bytes:
    lower = rel_path.lower()
    if lower == "license" or any(lower.endswith(ext) for ext in LF_EXTS):
        return data.replace(b"\r\n", b"\n")
    if any(lower.endswith(ext) for ext in CRLF_EXTS):
        return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    return data


def read_entries(directory, pattern):
    return {
        file.relative_to(directory).as_posix(): normalize_entry_bytes(file.relative_to(directory).as_posix(), file.read_bytes())
        for file in directory.glob(pattern) if file.is_file()
    }


def json_bytes(data):
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def release_version(manifest):
    browser_version = manifest["version"]
    product = manifest.get("version_name", browser_version)
    if product != browser_version and not re.fullmatch(r"\d+\.\d+\.\d+-rc\.[1-9]\d*", product):
        raise ValueError("Expected a numeric browser version or an explicit release candidate label")
    return product


def package_entries(manifest):
    name = f"VideoSave-{release_version(manifest)}"
    extension = ROOT / "extension"
    extension_files = {}
    for pattern in ("*.mjs", "*.html", "*.css", "icons/*.png"):
        extension_files.update(read_entries(extension, pattern))
    license_file = {"LICENSE": normalize_entry_bytes("LICENSE", (ROOT / "LICENSE").read_bytes())}

    def browser_manifest(*, firefox=False, android=False):
        data = {**manifest, "background": dict(manifest["background"]),
                "permissions": list(manifest["permissions"])}
        if firefox:
            data.pop("version_name", None)
            data["background"].pop("service_worker")
            data["permissions"].remove("offscreen")
            if android:
                data["permissions"].remove("downloads")
            else:
                data["browser_specific_settings"] = {
                    "gecko": manifest["browser_specific_settings"]["gecko"],
                }
        else:
            data["background"].pop("scripts")
            data.pop("browser_specific_settings")
        return json_bytes(data)

    dev_extension = {**extension_files, "manifest.json": normalize_entry_bytes("manifest.json", (extension / "manifest.json").read_bytes())}
    desktop = {file: normalize_entry_bytes(file, (ROOT / file).read_bytes()) for file in RELEASE_DOCS}
    desktop.update(read_entries(ROOT, "docs/compatibility-data/*.json"))
    desktop.update(read_entries(ROOT, "tests/compatibility*.mjs"))
    desktop.update({"extension/" + file: data for file, data in dev_extension.items()})
    desktop.update(read_entries(ROOT, "tools/*.mjs"))
    desktop.update(read_entries(ROOT, "tools/console/*"))
    for file in (
        "Start VideoSave.cmd", "Install VideoSave.cmd", "Uninstall VideoSave.cmd",
        "tools/start-windows.ps1", "tools/install-windows.ps1", "tools/uninstall-windows.ps1",
        "tools/start-unix.sh", "Launch VideoSave.command", "Uninstall VideoSave.command",
    ):
        desktop[file] = normalize_entry_bytes(file, (ROOT / file).read_bytes())

    unix_desktop = {
        k: v for k, v in desktop.items()
        if not k.endswith(".cmd") and not k.endswith(".ps1")
    }
    win_desktop = {
        k: v for k, v in desktop.items()
        if not k.endswith(".command")
    }

    return {
        f"{name}.zip": {f"{name}/{file}": data for file, data in win_desktop.items()},
        f"{name}-unix.tar.gz": {f"{name}/{file}": data for file, data in unix_desktop.items()},
        f"{name}-extension.zip": {**extension_files, **license_file, "manifest.json": browser_manifest()},
        f"{name}-firefox.zip": {**extension_files, **license_file, "manifest.json": browser_manifest(firefox=True)},
        f"{name}-android-dev.zip": {
            **extension_files, **license_file, "manifest.json": browser_manifest(firefox=True, android=True),
        },
    }


def installer_components():
    """Read portable package pins from their installers, including upstream commit and download checksum."""
    powershell = (ROOT / "tools/start-windows.ps1").read_text(encoding="utf-8-sig")
    extractor = (ROOT / "tools/setup-platform-downloads.mjs").read_text(encoding="utf-8")
    packages = []
    for name in ("nodePackage", "ffmpegPackage"):
        block = re.search(rf"(?m)^\${name} = @\{{\n(.*?)^\}}", powershell, re.S | re.M)
        if not block:
            raise ValueError(f"Missing installer package metadata for {name}")
        packages.append(dict(re.findall(r"\b(\w+)\s*=\s*'([^']+)'", block[1])))

    extractor_pins = dict(re.findall(r"(?m)^const (\w+) = '([^']+)';", extractor))
    packages.append({
        "name": "yt-dlp", "version": extractor_pins["release"], "license": "GPL-3.0-or-later",
        "source": extractor_pins["source"], "commit": extractor_pins["commit"],
        "sha256": extractor_pins["sha256"],
        "url": f"{extractor_pins['source']}/releases/download/{extractor_pins['release']}/yt-dlp.exe",
    })

    def component(package):
        if not re.fullmatch(r"[a-f\d]{40}", package["commit"]) or not re.fullmatch(r"[a-f\d]{64}", package["sha256"]):
            raise ValueError(f"Malformed installer pin for {package['name']}")
        refs = [
            {"type": "vcs", "url": f"{package['source']}/tree/{package['commit']}"},
            {"type": "distribution", "url": package["url"],
             "hashes": [{"alg": "SHA-256", "content": package["sha256"]}]},
        ]
        if "distributor" in package:
            refs.append({"type": "vcs", "url": f"{package['distributor']}/tree/{package['distributorCommit']}"})
        return {
            "type": "application", "bom-ref": f"installer:{package['name']}", "name": package["name"],
            "version": package["version"], "scope": "optional",
            "description": "Windows launcher download when a suitable local executable is unavailable.",
            "licenses": [{"license": {"name": package["license"]}}],
            "externalReferences": refs,
        }

    return [component(package) for package in packages]


def sbom(version, archives):
    project_ref = f"VideoSave:{version}"
    installers = installer_components()
    filename_components = [
        {"type": "file", "bom-ref": file.name, "name": file.name,
         "hashes": [{"alg": "SHA-256", "content": sha256(file.read_bytes()).hexdigest()}]}
        for file in archives
    ]
    return json_bytes({
        "$schema": "https://cyclonedx.org/schema/bom-1.6.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application", "bom-ref": project_ref, "name": "VideoSave", "version": version,
                "description": "Browser extension, local management console, and MCP companion with zero third-party npm packages.",
                "licenses": [{"license": {"id": "MIT"}}],
                "externalReferences": [{"type": "vcs", "url": PROJECT}],
            },
            "properties": [{"name": "videosave:sbom:scope", "value":
                            "Release ZIP/tar.gz archives and pinned Windows launcher downloads. "
                            "Browser builds and system-installed executables vary by installation."}],
        },
        "components": [*filename_components, *installers],
        "dependencies": [
            {"ref": project_ref, "dependsOn": [item["bom-ref"] for item in installers]},
            *({"ref": item["bom-ref"], "dependsOn": []} for item in installers),
        ],
    })


def write_zip(destination, entries):
    with NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
        staged = Path(temporary.name)
    try:
        with ZipFile(staged, "w") as archive:
            for name, content in sorted(entries.items()):
                entry = ZipInfo(name)
                entry.create_system = 3
                rel = name.split("/", 1)[1] if "/" in name else name
                mode = 0o100755 if rel in EXECUTABLE_SCRIPTS else 0o100644
                entry.external_attr = mode << 16
                archive.writestr(entry, content, compress_type=ZIP_DEFLATED)
        staged.replace(destination)
    finally:
        staged.unlink(missing_ok=True)


def write_tar_gz(destination, entries):
    with NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
        staged = Path(temporary.name)
    try:
        with staged.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
                    for name, content in sorted(entries.items()):
                        info = tarfile.TarInfo(name=name)
                        info.size = len(content)
                        info.mtime = 0
                        info.uid = 0
                        info.gid = 0
                        info.uname = ""
                        info.gname = ""
                        rel = name.split("/", 1)[1] if "/" in name else name
                        info.mode = 0o755 if rel in EXECUTABLE_SCRIPTS else 0o644
                        tar.addfile(info, io.BytesIO(content))
        staged.replace(destination)
    finally:
        staged.unlink(missing_ok=True)


def write_archive(destination, entries):
    if destination.name.endswith(".tar.gz"):
        write_tar_gz(destination, entries)
    else:
        write_zip(destination, entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    output = parser.parse_args().dist
    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    version = release_version(manifest)
    entries = package_entries(manifest)
    output.mkdir(exist_ok=True, parents=True)
    archives = [output / name for name in entries]
    for archive in archives:
        write_archive(archive, entries[archive.name])

    bom = output / f"VideoSave-{version}-sbom.cdx.json"
    bom.write_bytes(sbom(version, archives))
    subjects = [*archives, bom]
    checksums = [f"{sha256(file.read_bytes()).hexdigest()}  {file.name}" for file in subjects]
    (output / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="ascii", newline="\n")
    for file in subjects:
        print(file.name)


if __name__ == "__main__":
    main()
