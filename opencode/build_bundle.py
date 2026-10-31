#!/usr/bin/env python3
"""维护者更新无损源码包；固定 source 的安装者无需运行此脚本。"""
import argparse
import base64
import hashlib
import json
import lzma
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parent / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from install import PAYLOAD_FILES


def source_bytes():
    parts = []
    for name in sorted(PAYLOAD_FILES):
        content = (SCRIPTS / name).read_bytes()
        content.decode('utf-8')
        if b'\0' in content:
            raise ValueError('source contains NUL: ' + name)
        parts.extend((name.encode(), content))
    return b'\0'.join(parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='只核对摘要与解包原字节，不改文件')
    args = parser.parse_args()
    source = source_bytes()
    target = SCRIPTS / 'source.json'
    digest = hashlib.sha256(source).hexdigest()
    if args.check:
        value = json.loads(target.read_text())
        if value['sha256'] != digest or lzma.decompress(base64.b64decode(value['data'], validate=True)) != source:
            sys.exit('OpenCode source bundle is stale or damaged; run python3 -B opencode/build_bundle.py')
    else:
        target.write_text(json.dumps({'sha256': digest, 'data': base64.b64encode(lzma.compress(source)).decode()},
                                     indent=2) + '\n')


if __name__ == '__main__':
    main()
