"""Package the verified VideoSave v1.3.2 release as an MCP bundle."""

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo


RELEASE_SHA256 = "04514b12d0c3a776ea394881c7d502a43496a0eb96496f6eed4e5a9860ca64e4"
MANIFEST_FILE = Path(__file__).with_name("manifest.json")


def build_bundle(release_bytes):
    if sha256(release_bytes).hexdigest() != RELEASE_SHA256:
        raise ValueError("Input does not match the official VideoSave v1.3.2 ZIP checksum.")

    manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    root = f"VideoSave-{manifest['version']}/"
    payload = BytesIO()
    with ZipFile(BytesIO(release_bytes)) as release, ZipFile(payload, "w", ZIP_STORED) as bundle:
        extension = json.loads(release.read(root + "extension/manifest.json"))
        if extension.get("version_name", extension["version"]) != manifest["version"]:
            raise ValueError("The MCPB manifest version does not match the release.")

        manifest_entry = ZipInfo("manifest.json")
        manifest_entry.create_system = 3
        manifest_entry.external_attr = 0o644 << 16
        manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        bundle.writestr(manifest_entry, manifest_json.encode("utf-8"))

        for source in sorted(release.infolist(), key=lambda entry: entry.filename):
            relative_name = source.filename.removeprefix(root)
            entry = ZipInfo(relative_name)
            entry.create_system = source.create_system
            entry.external_attr = source.external_attr
            bundle.writestr(entry, release.read(source))

    return payload.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_zip", type=Path, help="official VideoSave-1.3.2.zip")
    parser.add_argument("output", type=Path, help="output .mcpb archive")
    args = parser.parse_args()
    if args.output.suffix != ".mcpb":
        parser.error("Output must use the .mcpb extension.")

    try:
        payload = build_bundle(args.release_zip.read_bytes())
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(payload)
    print(f"{sha256(payload).hexdigest()}  {args.output.name}")


if __name__ == "__main__":
    main()
