"""Record local source identity without creating a Git commit or uploading data."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default='w2-local-v0.2')
    parser.add_argument('--output', default='docs/开发执行/W2/验证/源码清单.json')
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to(ROOT):
        raise ValueError('Manifest output must stay inside the project')
    candidates = [ROOT / name for name in ['package.json', '.gitignore', 'AGENTS.md']]
    for directory in ['src', 'web', 'test', 'tools']:
        candidates.extend(path for path in (ROOT / directory).rglob('*')
                          if path.is_file() and '__pycache__' not in path.parts
                          and path.suffix in ['.mjs', '.json', '.py', '.ps1', '.html', '.css'])
    files = []
    for path in sorted(candidates, key=lambda path: path.relative_to(ROOT).as_posix()):
        data = path.read_bytes()
        files.append({'path': path.relative_to(ROOT).as_posix(),
                      'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    identity = hashlib.sha256(json.dumps(files, ensure_ascii=False, sort_keys=True,
                                        separators=(',', ':')).encode('utf-8')).hexdigest()
    result = {'version': args.version, 'contentSha256': identity,
              'sourceVersion': args.version + '+' + identity[:12],
              'recordedAtUtc': datetime.now(timezone.utc).isoformat(),
              'meaning': 'Local file content identity; not a Git commit or target-device acceptance.',
              'files': files}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(result['sourceVersion'])


if __name__ == '__main__':
    main()
