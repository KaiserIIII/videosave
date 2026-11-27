"""Build deterministic VideoSave release archives and a CycloneDX inventory."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
RELEASE_DOCS = (
    "LICENSE", "README.md", "README.zh-CN.md", "CHANGELOG.md", "SECURITY.md",
    "docs/videosave-0.9-detection.png", "docs/videosave-0.9-settings.png", "docs/videosave-mcp-control.png",
    "docs/architecture.md", "docs/compatibility-report.zh-CN.md", "docs/competitive-review.zh-CN.md",
    "docs/detection-research.zh-CN.md", "docs/privacy.md", "docs/mcp.md", "docs/install.md",
    "docs/hls-benchmark.zh-CN.md", "tests/benchmark-hls.mjs",
)
PROJECT = "https://github.com/KaiserIIII/videosave"


def read_entries(directory, pattern):
    return {file.relative_to(directory).as_posix(): file.read_bytes()
            for file in directory.glob(pattern) if file.is_file()}


def json_bytes(data):
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def package_entries(manifest):
    name = f"VideoSave-{manifest['version']}"
    extension = ROOT / "extension"
    extension_files = {}
    for pattern in ("*.mjs", "*.html", "*.css", "icons/*.png"):
        extension_files.update(read_entries(extension, pattern))
    license_file = {"LICENSE": (ROOT / "LICENSE").read_bytes()}

    def browser_manifest(*, firefox=False, android=False):
        data = {**manifest, "background": dict(manifest["background"]),
                "permissions": list(manifest["permissions"])}
        if firefox:
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

    dev_extension = {**extension_files, "manifest.json": (extension / "manifest.json").read_bytes()}
    desktop = {file: (ROOT / file).read_bytes() for file in RELEASE_DOCS}
    desktop.update(read_entries(ROOT, "docs/compatibility-data/*.json"))
    desktop.update(read_entries(ROOT, "tests/compatibility*.mjs"))
    desktop.update({"extension/" + file: data for file, data in dev_extension.items()})
    desktop.update(read_entries(ROOT, "tools/*.mjs"))
    for file in ("Start VideoSave.cmd", "tools/start-windows.ps1"):
        desktop[file] = (ROOT / file).read_bytes()

    return {
        f"{name}.zip": {f"{name}/{file}": data for file, data in desktop.items()},
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
                "description": "Browser extension and local companion with JavaScript standard-library imports.",
                "licenses": [{"license": {"id": "MIT"}}],
                "externalReferences": [{"type": "vcs", "url": PROJECT}],
            },
            "properties": [{"name": "videosave:sbom:scope", "value":
                            "Release ZIP files and pinned Windows launcher downloads. "
                            "Browser builds and system-installed executables vary by installation."}],
        },
        "components": [*filename_components, *installers],
        "dependencies": [
            {"ref": project_ref, "dependsOn": [item["bom-ref"] for item in installers]},
            *({"ref": item["bom-ref"], "dependsOn": []} for item in installers),
        ],
    })


def write_archive(destination, entries):
    with NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    output = parser.parse_args().dist
    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
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
