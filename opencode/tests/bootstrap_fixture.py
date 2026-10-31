"""Execute rendered startup with only external release/Node downloads replaced.

The shell is passed as one real exec argument, as in the Coder startup path.
The Python shim delays the bootstrap's main call so fixture archives can replace
network downloads; decoded installer/helpers and all installation paths still run.
"""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SCRIPT_BUDGET = 65536
BOOTSTRAP_MARKER = "<<'OPENCODE_BOOTSTRAP'\n"


def unpack(script):
    encoded = re.search(r"base64\.b64decode\('([A-Za-z0-9+/=]+)'\)", script)
    if encoded is None:
        raise AssertionError('rendered bootstrap payload missing')
    parts = gzip.decompress(base64.b64decode(encoded.group(1))).decode().split('\0')
    return {'config': json.loads(parts[0]), 'files': dict(zip(parts[1::2], parts[2::2], strict=True))}


def render(bundle):
    """Unit fixture; validate_terraform uses the actual Terraform-rendered script."""
    template = (Path(__file__).resolve().parents[1] / 'scripts/install.sh.tftpl').read_text()
    parts = [json.dumps(bundle['config'])] + [part for pair in sorted(bundle['files'].items()) for part in pair]
    encoded = base64.b64encode(gzip.compress('\0'.join(parts).encode(), mtime=0)).decode()
    return template.replace('${bundle}', encoded)


def launch(script, home, fixture_dir, release, node, offline=False):
    size = len(script.encode('utf-8'))
    assert size <= SCRIPT_BUDGET, f'actual rendered startup is {size} bytes (budget {SCRIPT_BUDGET})'
    shim = fixture_dir / 'bin'
    shim.mkdir(mode=0o700, exist_ok=True)
    helper = str(Path(__file__).resolve().parent)
    launcher = shim / 'python3'
    launcher.write_text('#!/usr/bin/python3\nimport os, sys\n'
                        'if sys.argv[1:] == ["-B", "-"]:\n'
                        f'    sys.path.insert(0, {helper!r})\n'
                        '    from bootstrap_fixture import execute_fixture\n'
                        '    sys.exit(execute_fixture())\n'
                        'os.execv("/usr/bin/python3", ["/usr/bin/python3", *sys.argv[1:]])\n')
    launcher.chmod(0o700)
    config = fixture_dir / 'fixture.json'
    config.write_text(json.dumps({'release': str(release), 'node': str(node),
                                  'download_log': str(fixture_dir / 'downloads.jsonl'),
                                  'offline': offline}))
    config.chmod(0o600)
    # Never inherit provider, MCP, Coder, Git or callback credentials.
    env = {'HOME': str(home), 'PATH': str(shim) + ':/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'PYTHONDONTWRITEBYTECODE': '1', 'OPENCODE_BOOTSTRAP_FIXTURE': str(config)}
    return subprocess.run(['/usr/bin/env', 'bash', '-c', script], env=env,
                          cwd=fixture_dir, capture_output=True, text=True, timeout=30)


def verify_startup(script, fixture_dir):
    """Run the exact rendered command twice, checking state and offline reuse."""
    import test_install as fixtures

    fixture_dir.mkdir(mode=0o700)
    home = fixture_dir / 'home'
    home.mkdir(mode=0o700)
    bundle = unpack(script)
    configured = bundle['config']['install_root']
    root = Path(configured) if configured else home / '.coder-opencode'
    assert root.is_relative_to(fixture_dir), 'fixture may only install inside its private scratch directory'
    if configured:
        root.parent.mkdir(mode=0o1777, parents=True)
        root.parent.chmod(0o1777)
    sibling = root.parent / 'unrelated-tasks'
    sibling.mkdir(mode=0o700)
    (sibling / 'preserved').write_bytes(b'unrelated sibling task bytes')
    sibling_state = (sibling.stat().st_uid, sibling.stat().st_mode, (sibling / 'preserved').read_bytes())
    release, node = fixture_dir / 'release.tar.gz', fixture_dir / 'node.tar.gz'
    fixtures.release(release, bundle['config']['release_tag'])
    fixtures.node(node)
    first = launch(script, home, fixture_dir, release, node)
    assert first.returncode == 0, first.stderr
    active = os.readlink(root / 'active')
    assert (root / 'runtime/state/fixture-startup-recoveries').read_text() == '1'
    task = root / 'runtime/tasks' / ('task_' + 'a' * 64)
    task.mkdir(mode=0o700)
    task_state = task / 'task.json'
    task_state.write_bytes(b'{"state":"outbox","fixture":"preserve"}')
    task_state.chmod(0o600)
    session = root / 'runtime/home/.acpx/session-fixture'
    session.write_bytes(b'old session')
    cache = root / 'runtime/cache/cache-fixture'
    cache.write_bytes(b'old cache')
    preserved = {path: (path.read_bytes(), path.stat().st_uid, path.stat().st_mode)
                 for path in (task_state, session, cache)}
    repeated = launch(script, home, fixture_dir, release, node, offline=True)
    assert repeated.returncode == 0, repeated.stderr
    assert os.readlink(root / 'active') == active
    assert (root / 'runtime/state/fixture-startup-recoveries').read_text() == '2'
    assert json.loads((root / 'status.json').read_text())['state'] == 'ready'
    assert preserved == {path: (path.read_bytes(), path.stat().st_uid, path.stat().st_mode) for path in preserved}
    assert sibling_state == (sibling.stat().st_uid, sibling.stat().st_mode, (sibling / 'preserved').read_bytes())
    assert len((fixture_dir / 'downloads.jsonl').read_text().splitlines()) == 2
    for tool in ('opencode', 'acpx', 'opencode-task'):
        assert (root / 'bin' / tool).is_file()
        assert not (root / 'bin' / tool).is_symlink()
    return {'script_bytes': len(script.encode()), 'uid': os.getuid(),
            'root_mode': oct(root.stat().st_mode & 0o777),
            'task_mode': oct(task.parent.stat().st_mode & 0o777),
            'first_and_cached_startup': 'passed', 'downloads': 2,
            'startup_recover_invocations': 2, 'runtime_and_sibling_preservation': 'passed'}


def execute_fixture():
    config = json.loads(Path(os.environ['OPENCODE_BOOTSTRAP_FIXTURE']).read_text())
    namespace = {'__name__': 'bootstrap_fixture_installer'}
    exec(compile(sys.stdin.read(), '<rendered-bootstrap>', 'exec'), namespace)
    node = Path(config['node'])
    # Same synthetic Node pin used by the existing offline installer fixtures.
    namespace['NODE_SHA256'] = hashlib.sha256(node.read_bytes()).hexdigest()

    def download(url, destination, expected, env):
        if config['offline']:
            raise AssertionError('cached startup attempted a download')
        if url == namespace['NODE_URL']:
            source = node
        else:
            selected = namespace['BUNDLE']['config']
            required = ('https://github.com/Ricky-Hao/opencode/releases/download/' +
                        selected['release_tag'] + '/' + selected['release_asset'])
            assert url == required and expected == selected['release_sha256']
            source = Path(config['release'])
        with Path(config['download_log']).open('a') as stream:
            stream.write(json.dumps({'archive': source.name}) + '\n')
        shutil.copyfile(source, destination)

    namespace['download'] = download
    return namespace['main']()
