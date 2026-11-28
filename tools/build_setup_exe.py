"""Compile the native Windows WinForms graphical installer VideoSave-<version>-Setup.exe."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from build_release import ROOT, release_version

CSC_CANDIDATES = (
    Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
)


def find_csc() -> Path:
    for candidate in CSC_CANDIDATES:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("Could not locate .NET Framework 4.x csc.exe to build Setup.exe")


def build_setup_exe(dist_dir: Path) -> Path:
    if os.name != "nt":
        raise RuntimeError("Building Windows Setup.exe requires Windows with .NET Framework 4.x csc.exe")
    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    version = release_version(manifest)
    payload_zip = dist_dir / f"VideoSave-{version}.zip"
    if not payload_zip.is_file():
        raise FileNotFoundError(f"Expected {payload_zip} before building Setup.exe; run build_release.py first")

    cs_source = ROOT / "installer" / "windows" / "VideoSaveSetup.cs"
    src_text = cs_source.read_text(encoding="utf-8")
    # Ensure embedded version constant matches extension/manifest.json
    import re
    patched = re.sub(r'private const string Version = "[^"]+";', f'private const string Version = "{version}";', src_text)
    temp_cs = dist_dir / "_VideoSaveSetup.gen.cs"
    temp_cs.write_text(patched, encoding="utf-8")
    out_exe = dist_dir / f"VideoSave-{version}-Setup.exe"
    try:
        csc = find_csc()
        cmd = [
            str(csc),
            "/nologo",
            "/optimize+",
            "/utf8output",
            "/target:winexe",
            f"/out:{out_exe}",
            "/r:System.dll",
            "/r:System.Core.dll",
            "/r:System.Drawing.dll",
            "/r:System.Windows.Forms.dll",
            "/r:System.IO.Compression.dll",
            "/r:System.IO.Compression.FileSystem.dll",
            "/r:Microsoft.CSharp.dll",
            f"/resource:{payload_zip},VideoSavePayload.zip",
            str(temp_cs),
        ]
        res = subprocess.run(cmd, capture_output=True, check=False)
        if res.returncode != 0:
            out_s = res.stdout.decode("utf-8", errors="replace")
            err_s = res.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"csc.exe failed:\n{out_s}\n{err_s}")
    finally:
        temp_cs.unlink(missing_ok=True)
    return out_exe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    out = build_setup_exe(parser.parse_args().dist)
    print(out.name)


if __name__ == "__main__":
    main()
