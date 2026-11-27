"""Verify VideoSave release checksums, exact archive contents and packaged MCP."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from build_release import ROOT, package_entries, sbom


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(file):
    result = sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def verify_checksums(directory, names):
    expected = {f"{digest(directory / name)}  {name}" for name in names}
    actual = (directory / "SHA256SUMS.txt").read_text(encoding="ascii").splitlines()
    require(len(actual) == len(names) and set(actual) == expected,
            "SHA256SUMS.txt must contain the exact SHA-256 of each distribution asset")
    for entry in sorted(expected):
        print(f"Verified SHA-256 {entry}", flush=True)


def verify_archive(file, expected):
    with ZipFile(file) as archive:
        members = archive.infolist()
        require(len(members) == len(expected) and {entry.filename for entry in members} == expected.keys(),
                f"{file.name} has missing, unexpected, or duplicate entries")
        for entry in members:
            mode = entry.external_attr >> 16
            require(stat.S_ISREG(mode), f"{file.name} contains a non-regular file: {entry.filename}")
            contents = expected[entry.filename]
            require(entry.file_size == len(contents) and archive.read(entry) == contents,
                    f"{file.name} differs from source: {entry.filename}")
    print(f"Verified {file.name} ({len(expected)} files)", flush=True)


def verify_browser_manifest(entries, target, version):
    manifest = json.loads(entries["manifest.json"])
    require(manifest["manifest_version"] == 3 and manifest["version"] == version,
            f"Incorrect manifest version for {target}")
    permissions = manifest["permissions"]
    expected_permissions = {"activeTab", "alarms", "scripting", "storage", "webRequest"}
    if target != "android":
        expected_permissions.add("downloads")
    if target == "chromium":
        expected_permissions.add("offscreen")
    require(set(permissions) == expected_permissions and len(permissions) == len(expected_permissions),
            f"Unexpected permissions for {target}")
    require(set(manifest["host_permissions"]) == {"http://*/*", "https://*/*"},
            f"Unexpected host permissions for {target}")
    background = manifest["background"]
    if target == "chromium":
        require("scripts" not in background and background.get("service_worker") in entries,
                "Chromium background service worker is missing")
        require("browser_specific_settings" not in manifest, "Unexpected browser settings in Chromium ZIP")
    else:
        require("service_worker" not in background and background.get("scripts") and
                all(item in entries for item in background["scripts"]),
                f"Firefox background scripts are missing for {target}")
        browser_settings = manifest["browser_specific_settings"]
        require(bool(browser_settings.get("gecko", {}).get("id")), "Firefox add-on ID is missing")
        require(("gecko_android" in browser_settings) == (target == "android"),
                f"Unexpected Android browser settings for {target}")
    require(manifest["action"]["default_popup"] in entries, f"Extension popup is missing for {target}")
    for icon in (*manifest["icons"].values(), *manifest["action"]["default_icon"].values()):
        require(icon in entries, f"Extension icon is missing for {target}: {icon}")


def windows_smoke(archive_path, name, version):
    with TemporaryDirectory(prefix="VideoSave release ") as directory:
        temp = Path(directory)
        with ZipFile(archive_path) as archive:
            archive.extractall(temp)
        package = temp / name
        env = {key: value for key, value in os.environ.items()
               if key.upper() not in {"MEDIA_TOOLKIT_URL", "MEDIA_TOOLKIT_LOCAL_PAIRING", "MEDIA_TOOLKIT_TOKEN", "YTDLP_BIN"}}
        env.update({"OUT_DIR": str(temp / "downloads"), "MEDIA_TOOLKIT_SETTINGS": str(temp / "settings.sqlite")})
        command = env.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
        launch = subprocess.run(
            f'"{command}" /d /s /c "call "Start VideoSave.cmd" -McpConfig -SkipPlatform"',
            cwd=package, env=env, capture_output=True, encoding="utf-8", errors="replace", input="", timeout=360,
        )
        require(launch.returncode == 0, f"Packaged launcher failed: {launch.stderr.strip()}")
        config = json.loads(launch.stdout)["mcpServers"]["videosave"]
        executable = Path(config["command"])
        require(executable.is_absolute() and executable.is_file(),
                "Launcher did not provide an absolute Node.js executable")
        entry = package / "tools" / "mcp-server.mjs"
        require(config["args"] == [str(entry)], "MCP configuration does not reference the extracted package")
        for key in ("FFMPEG_BIN", "FFPROBE_BIN"):
            executable = Path(config["env"][key])
            require(executable.is_absolute() and executable.is_file(), f"Launcher did not provide {key}")

        subprocess.run(
            [config["command"], str(ROOT / "tests" / "release-smoke.mjs"), str(entry), version],
            cwd=temp, env={**env, **config["env"]}, check=True, timeout=90,
        )
    print("Verified Windows launcher and packaged MCP from the extracted ZIP", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist", help="Directory containing the release files")
    parser.add_argument("--smoke-windows", action="store_true", help="Verify Windows setup and packaged MCP download")
    args = parser.parse_args()
    if args.smoke_windows and os.name != "nt":
        parser.error("--smoke-windows requires Windows")
    try:
        manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
        version = manifest["version"]
        name = f"VideoSave-{version}"
        packages = package_entries(manifest)
        bom_name = f"{name}-sbom.cdx.json"
        verify_checksums(args.dist, (*packages, bom_name))
        for filename, entries in packages.items():
            verify_archive(args.dist / filename, entries)
        verify_browser_manifest(packages[f"{name}-extension.zip"], "chromium", version)
        verify_browser_manifest(packages[f"{name}-firefox.zip"], "firefox", version)
        verify_browser_manifest(packages[f"{name}-android-dev.zip"], "android", version)
        desktop = packages[f"{name}.zip"]
        for path in ("Start VideoSave.cmd", "tools/start-windows.ps1", "tools/mcp-server.mjs", "tools/server.mjs"):
            require(f"{name}/{path}" in desktop, f"Desktop package is missing {path}")
        require((args.dist / bom_name).read_bytes() == sbom(version, [args.dist / filename for filename in packages]),
                "SBOM does not match the archive checksums and Windows launcher pins")
        print(f"Verified {bom_name} and browser permission profiles", flush=True)
        if args.smoke_windows:
            windows_smoke(args.dist / f"{name}.zip", name, version)
    except (OSError, ValueError, KeyError, BadZipFile, subprocess.SubprocessError) as error:
        print(f"Release verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
