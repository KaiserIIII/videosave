"""Build and verify the standalone VideoSave Android APK using Android SDK build-tools (aapt2 + javac + d8 + zipalign + apksigner).

Signing policy:
- Signing keys are NEVER committed to Git.
- When VIDEOSAVE_ANDROID_KEYSTORE / VIDEOSAVE_ANDROID_KEYSTORE_PASS / VIDEOSAVE_ANDROID_KEY_ALIAS
  are provided in the environment, produces a formally signed release APK:
    VideoSave-<version>-android-universal.apk
- Otherwise generates a temporary ephemeral debug keystore (deleted after build) and explicitly
  labels the artifact:
    VideoSave-<version>-android-debug.apk
"""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory

from build_release import ROOT, release_version


def find_android_sdk() -> Path:
    candidates = [
        os.environ.get("ANDROID_HOME"),
        os.environ.get("ANDROID_SDK_ROOT"),
        str(Path.home() / "AppData/Local/Android/Sdk"),
        str(Path.home() / "Library/Android/sdk"),
        "/usr/local/lib/android/sdk",
        str(Path.home() / "Android/Sdk"),
    ]
    for c in candidates:
        if c and Path(c).is_dir() and (Path(c) / "build-tools").is_dir():
            return Path(c)
    raise FileNotFoundError("Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT.")


def find_jdk_bin() -> Path:
    javac = shutil.which("javac")
    if javac:
        return Path(javac).parent
    candidates = [
        os.environ.get("JAVA_HOME"),
        r"C:\Program Files\Android\jdk\jdk-8.0.302.8-hotspot\jdk8u302-b08",
        r"C:\Program Files\Android\Android Studio\jbr",
    ]
    for c in candidates:
        if c and (Path(c) / "bin" / ("javac.exe" if os.name == "nt" else "javac")).is_file():
            return Path(c) / "bin"
    raise FileNotFoundError("JDK (javac/keytool) not found. Set JAVA_HOME.")


def latest_subdir(parent: Path, required_file: str | None = None) -> Path:
    def ver_key(p: Path):
        nums = tuple(int(n) for n in re.findall(r"\d+", p.name))
        return (nums, p.name)

    dirs = [p for p in parent.iterdir() if p.is_dir()]
    if required_file:
        matching = [
            p for p in dirs
            if (p / required_file).is_file()
            or (os.name == "nt" and any((p / (required_file + ext)).is_file() for ext in (".exe", ".bat", ".cmd")))
        ]
        if matching:
            dirs = matching
    dirs.sort(key=ver_key)
    if not dirs:
        raise FileNotFoundError(f"No matching subdirectories found inside {parent}")
    return dirs[-1]


def tool_exe(directory: Path, name: str) -> str:
    if os.name == "nt":
        for ext in (".exe", ".bat", ".cmd"):
            p = directory / (name + ext)
            if p.is_file():
                return str(p)
    p = directory / name
    if p.is_file():
        return str(p)
    raise FileNotFoundError(f"Tool {name} not found in {directory}")


def build_android_apk(dist_dir: Path) -> dict:
    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    version = release_version(manifest)
    sdk = find_android_sdk()
    jdk_bin = find_jdk_bin()
    build_tools = latest_subdir(sdk / "build-tools", "aapt2")
    platform_dir = latest_subdir(sdk / "platforms", "android.jar")
    android_jar = platform_dir / "android.jar"

    aapt2 = tool_exe(build_tools, "aapt2")
    d8 = tool_exe(build_tools, "d8")
    zipalign = tool_exe(build_tools, "zipalign")
    apksigner = tool_exe(build_tools, "apksigner")
    javac = tool_exe(jdk_bin, "javac")
    keytool = tool_exe(jdk_bin, "keytool")

    android_root = ROOT / "android"
    java_sources = sorted((android_root / "src").rglob("*.java"))
    if not java_sources:
        raise FileNotFoundError("No Java sources found in android/src")

    # Configure JAVA_HOME for d8/apksigner scripts
    env = {**os.environ, "JAVA_HOME": str(jdk_bin.parent), "PATH": f"{jdk_bin}{os.pathsep}{os.environ.get('PATH', '')}"}

    release_ks = os.environ.get("VIDEOSAVE_ANDROID_KEYSTORE")
    release_pass = os.environ.get("VIDEOSAVE_ANDROID_KEYSTORE_PASS")
    release_alias = os.environ.get("VIDEOSAVE_ANDROID_KEY_ALIAS")
    is_release_signed = bool(release_ks and release_pass and release_alias and Path(release_ks).is_file())

    with TemporaryDirectory(prefix="videosave-apk-build-") as td:
        work = Path(td)
        res_zip = work / "res.zip"
        gen_dir = work / "gen"
        cls_dir = work / "classes"
        dex_dir = work / "dex"
        gen_dir.mkdir()
        cls_dir.mkdir()
        dex_dir.mkdir()

        # 1. Compile Android resources
        subprocess.run([aapt2, "compile", "--dir", str(android_root / "res"), "-o", str(res_zip)], check=True, env=env)

        # 2. Link resources + AndroidManifest.xml -> base.apk + R.java
        base_apk = work / "base.apk"
        subprocess.run([
            aapt2, "link",
            "-I", str(android_jar),
            "--manifest", str(android_root / "AndroidManifest.xml"),
            "--version-name", version,
            "--java", str(gen_dir),
            "-o", str(base_apk),
            str(res_zip),
        ], check=True, env=env)

        # 3. Compile Java 8 sources + generated R.java
        r_sources = list(gen_dir.rglob("*.java"))
        subprocess.run([
            javac, "-encoding", "UTF-8", "-source", "1.8", "-target", "1.8",
            "-classpath", str(android_jar),
            "-d", str(cls_dir),
            *[str(s) for s in (*java_sources, *r_sources)],
        ], check=True, env=env)

        # 4. Dex bytecode via d8
        class_files = sorted(cls_dir.rglob("*.class"))
        subprocess.run([
            d8, "--min-api", "26", "--lib", str(android_jar),
            "--output", str(dex_dir),
            *[str(c) for c in class_files],
        ], check=True, env=env)

        # 5. Merge classes.dex into APK
        from zipfile import ZipFile, ZIP_DEFLATED
        merged_apk = work / "merged.apk"
        shutil.copy2(base_apk, merged_apk)
        with ZipFile(merged_apk, "a") as zf:
            zf.write(dex_dir / "classes.dex", "classes.dex", compress_type=ZIP_DEFLATED)

        # 6. Zipalign on 4-byte boundary
        aligned_apk = work / "aligned.apk"
        subprocess.run([zipalign, "-f", "-p", "4", str(merged_apk), str(aligned_apk)], check=True, env=env)

        # 7. Sign APK (formal release keystore if configured, else ephemeral debug key clearly labeled)
        dist_dir.mkdir(parents=True, exist_ok=True)
        out_name = f"VideoSave-{version}-android-universal.apk" if is_release_signed else f"VideoSave-{version}-android-debug.apk"
        out_apk = dist_dir / out_name

        if is_release_signed:
            ks_path, ks_pass, ks_alias = release_ks, release_pass, release_alias
        else:
            ks_path = str(work / "ephemeral-debug.jks")
            ks_pass = "videosave-debug-only"
            ks_alias = "videosave-debug"
            subprocess.run([
                keytool, "-genkeypair", "-v",
                "-keystore", ks_path,
                "-storepass", ks_pass,
                "-keypass", ks_pass,
                "-alias", ks_alias,
                "-keyalg", "RSA", "-keysize", "2048", "-validity", "365",
                "-dname", "CN=VideoSave Debug Build, O=VideoSave Contributors, C=US",
            ], check=True, capture_output=True, env=env)

        subprocess.run([
            apksigner, "sign",
            "--ks", ks_path,
            "--ks-pass", f"pass:{ks_pass}",
            "--ks-key-alias", ks_alias,
            "--key-pass", f"pass:{ks_pass}",
            "--out", str(out_apk),
            str(aligned_apk),
        ], check=True, env=env)

        # 8. Strictly verify APK signature + badging
        verify_res = subprocess.run([apksigner, "verify", "--verbose", str(out_apk)], check=True, capture_output=True, text=True, env=env)
        badging_res = subprocess.run([aapt2, "dump", "badging", str(out_apk)], check=True, capture_output=True, text=True, env=env)
        idsig = Path(str(out_apk) + ".idsig")
        idsig.unlink(missing_ok=True)

    digest = sha256(out_apk.read_bytes()).hexdigest()
    return {
        "file": str(out_apk),
        "name": out_apk.name,
        "size": out_apk.stat().st_size,
        "sha256": digest,
        "signingMode": "release-keystore" if is_release_signed else "ephemeral-debug-build",
        "buildTools": build_tools.name,
        "compileSdk": platform_dir.name,
        "apksignerVerified": "Verifies" in verify_res.stdout,
        "badgingSummary": badging_res.stdout.splitlines()[:4],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    info = build_android_apk(parser.parse_args().dist)
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
