"""Build the two VideoSave Commons store ZIPs and their reproducible source archive."""

import argparse
from hashlib import sha256
from pathlib import Path
import sys


EDITION = Path(__file__).resolve().parent
ROOT = EDITION.parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from build_release import json_bytes, normalize_entry_bytes, write_zip

VERSION = '1.0.0'
NAME = f'VideoSave-Commons-{VERSION}'
RUNTIME_FILES = ('background.js', 'media.mjs', 'save.html', 'save.mjs', 'style.css')
ICON_SIZES = (16, 32, 48, 128)


def source_entries(paths):
    return {rel: normalize_entry_bytes(rel, (ROOT / rel).read_bytes()) for rel in paths}


def package_entries(firefox):
    entries = {name: normalize_entry_bytes(name, (EDITION / name).read_bytes())
               for name in RUNTIME_FILES}
    entries['LICENSE'] = normalize_entry_bytes('LICENSE', (ROOT / 'LICENSE').read_bytes())
    icons = {str(size): f'icons/icon-{size}.png' for size in ICON_SIZES}
    entries.update({icon: (ROOT / 'extension' / icon).read_bytes() for icon in icons.values()})
    manifest = {
        'manifest_version': 3,
        'name': 'VideoSave Commons',
        'version': VERSION,
        'description': 'Save original WebM and Ogg media files from Wikimedia Commons.',
        'host_permissions': ['https://upload.wikimedia.org/*'],
        'background': {'scripts': ['background.js']} if firefox else {'service_worker': 'background.js'},
        'icons': icons,
        'action': {'default_title': 'VideoSave Commons', 'default_icon': icons},
        'content_security_policy': {
            'extension_pages': "default-src 'self'; script-src 'self'; object-src 'none'; "
                               "connect-src https://upload.wikimedia.org; base-uri 'none'",
        },
    }
    if firefox:
        manifest['browser_specific_settings'] = {'gecko': {
            'id': 'videosave-commons@kaiseriiii.github.io',
            'strict_min_version': '140.0',
            'data_collection_permissions': {'required': ['none']},
        }}
    entries['manifest.json'] = json_bytes(manifest)
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist' / 'store-edition')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    packages = {
        f'{NAME}-chromium.zip': package_entries(firefox=False),
        f'{NAME}-firefox.zip': package_entries(firefox=True),
    }
    prefix = EDITION.relative_to(ROOT).as_posix()
    source_paths = [
        'LICENSE', 'tools/build_release.py',
        *(f'{prefix}/{name}' for name in (*RUNTIME_FILES, 'build.py', 'LISTING.md', 'PRIVACY.md')),
        *(f'extension/icons/icon-{size}.png' for size in ICON_SIZES),
        'tests/store-edition.test.mjs',
    ]
    packages[f'{NAME}-source.zip'] = source_entries(source_paths)
    checksums = []
    for name, entries in packages.items():
        destination = args.output / name
        write_zip(destination, entries)
        digest = sha256(destination.read_bytes()).hexdigest()
        checksums.append(f'{digest}  {name}\n')
        print(f'{digest}  {destination}')
    (args.output / 'SHA256SUMS.txt').write_bytes(''.join(checksums).encode('utf-8'))


if __name__ == '__main__':
    main()
