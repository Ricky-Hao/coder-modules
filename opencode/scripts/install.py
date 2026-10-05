#!/usr/bin/env python3
"""Verified, non-root-first release installer. No source compilation or model calls."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

NODE_VERSION = '22.22.0'
NODE_SHA256 = '9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37'
NODE_URL = 'https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz'
ACPX_VERSION = '0.19.3'
TARGET = 'opencode-linux-x64-baseline'
PAYLOAD_FILES = {'install.py', 'runtime.py', 'safety.py', 'profiles.py', 'shell_path.py',
                 'profile-env.json', 'package.json', 'package-lock.json'}


class UnsupportedPlatform(ValueError):
    pass


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate(config):
    if config.get('runtime_profile', 'env') not in ('none', 'env'):
        raise ValueError('unknown runtime profile')
    if not re.fullmatch(r'v\d+\.\d+\.\d+-ricky\.[1-9]\d*', config['release_tag']):
        raise ValueError('expected a fixed own release tag')
    if config['release_asset'] != TARGET + '-' + config['release_tag'] + '.tar.gz':
        raise ValueError('asset must match the baseline target and tag')
    if not re.fullmatch(r'[0-9a-f]{64}', config['release_sha256']):
        raise ValueError('expected a reviewed SHA256')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', config['workspace_id']):
        raise ValueError('invalid workspace identity')
    root = Path(config['install_root'])
    if (not root.is_absolute() or str(root) != config['install_root'] or '..' in root.parts
            or any(c in str(root) for c in '\n\r\0:') or root == Path('/')):
        raise ValueError('expected an absolute private installation root')
    if root.parts[1] in ('usr', 'etc', 'bin', 'sbin', 'lib', 'lib64', 'boot', 'dev', 'proc', 'sys', 'opt'):
        raise ValueError('system/global installation paths are prohibited')
    for key in config['runtime_env_allowlist']:
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            raise ValueError('invalid runtime environment name')


def prerequisites():
    if sys.version_info < (3, 11):
        raise ValueError('Python 3.11+ required')
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64') or platform.libc_ver()[0] != 'glibc':
        raise UnsupportedPlatform('Linux x64 glibc required')
    for command in ('bash', 'curl', 'tar', 'xz'):
        if shutil.which(command) is None:
            raise ValueError('missing prerequisite: ' + command)


def extract(archive, destination, node=False):
    """Never use tar.extract: create only fresh regular files/directories.

    Node's internal npm/npx symlinks are validated then omitted: callers use
    node + npm-cli.js directly. Release links and all special files are refused.
    """
    with tarfile.open(archive, 'r:*') as source:
        seen = set()
        for member in source:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or member.name in seen:
                raise ValueError('unsafe archive path')
            seen.add(member.name)
            if node:
                if path.parts[0] != 'node-v' + NODE_VERSION + '-linux-x64':
                    raise ValueError('unexpected Node archive root')
                path = PurePosixPath(*path.parts[1:])
            if member.issym() and node:
                import posixpath
                target = posixpath.normpath(str(path.parent / member.linkname))
                if member.linkname.startswith('/') or target == '..' or target.startswith('../'):
                    raise ValueError('unsafe Node link')
                continue
            if not member.isdir() and not member.isfile():
                raise ValueError('archive links/special files prohibited')
            dest = destination / str(path)
            if member.isdir():
                dest.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with dest.open('xb') as out, source.extractfile(member) as stream:
                shutil.copyfileobj(stream, out)
            dest.chmod(0o700 if member.mode & 0o111 else 0o600)


def clean_env(home, node=None):
    return {'HOME': str(home), 'PATH': (str(node / 'bin') + ':' if node else '') + '/usr/bin:/bin',
            'LANG': 'C.UTF-8', 'TMPDIR': str(home), 'CI': '1',
            'NPM_CONFIG_USERCONFIG': str(home / 'empty-user.npmrc'),
            'NPM_CONFIG_GLOBALCONFIG': str(home / 'empty-global.npmrc'),
            'NPM_CONFIG_CACHE': str(home / 'npm-cache'), 'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/'}


def download(url, dest, expected, env):
    subprocess.run(['curl', '-q', '-fsSL', '--proto', '=https', '--proto-redir', '=https',
                    '--tlsv1.2', '--connect-timeout', '20', '--max-time', '300',
                    url, '-o', str(dest)], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if digest(dest) != expected:
        raise ValueError('download checksum mismatch')


def check_versions(version, tag):
    home = version / 'check-home'
    home.mkdir(mode=0o700)
    try:
        env = clean_env(home, version / 'node')
        commands = [([version / 'opencode', '--version'], 'opencode ' + tag),
                    ([version / 'node/bin/node', '--version'], 'v' + NODE_VERSION),
                    ([version / 'node/bin/node', version / 'node_modules/acpx/dist/cli.js', '--version'], ACPX_VERSION)]
        for args, expected in commands:
            result = subprocess.run([str(a) for a in args], env=env, cwd=home, check=True,
                                    capture_output=True, text=True, timeout=30)
            if result.stdout.strip() != expected:
                raise ValueError('installed version mismatch')
    finally:
        shutil.rmtree(home)


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        rel = str(path.relative_to(root))
        if rel == 'installed.json':
            continue
        info = path.lstat()
        if info.st_uid != os.getuid():
            raise ValueError('foreign installed file')
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('installed link leaves version')
            result[rel] = {'link': os.readlink(path)}
        elif path.is_file():
            if info.st_nlink != 1:
                raise ValueError('installed hardlink prohibited')
            result[rel] = {'sha256': digest(path), 'mode': stat.S_IMODE(info.st_mode)}
        elif not path.is_dir():
            raise ValueError('installed special file prohibited')
    return result


def wrapper(root, tool):
    return '#!/usr/bin/env bash\nset -euo pipefail\nexec python3 -B ' + shlex.quote(str(root / 'active/runtime.py')) + ' ' + tool + ' "$@"\n'


def install(bundle):
    config, files = dict(bundle['config']), bundle['files']
    if set(files) != PAYLOAD_FILES:
        raise ValueError('unexpected or missing payload files')
    # The inline Terraform bootstrap provides this module without writing temporary code globally.
    safety = {}
    exec(compile(files['safety.py'], 'safety.py', 'exec'), safety)
    shell_path = {'__name__': 'shell_path'}
    exec(compile(files['shell_path.py'], 'shell_path.py', 'exec'), shell_path)
    user_home = os.environ.get('HOME', '')
    home_lock = shell_path['home_fd'](user_home)
    os.close(home_lock)
    if not config['install_root']:
        config['install_root'] = str(Path(user_home) / '.coder-opencode')
    config.setdefault('runtime_profile', 'env')
    validate(config)
    root = Path(config['install_root'])
    safety['ancestors'](root)
    os.umask(0o077)
    # Serialize child + marker creation on the already-existing trusted parent.
    parent_fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(parent_fd, fcntl.LOCK_EX)
        created = False
        try:
            root.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        safety['directory'](root)
        marker = root / 'owner.json'
        if created:
            safety['write_json'](marker, {'schema': 1, 'uid': os.getuid(), 'workspace_id': config['workspace_id']})
        elif not os.path.lexists(marker):
            raise ValueError('refusing to adopt existing foreign/unmarked path')
        safety['owner'](root, config['workspace_id'])
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    fd = os.open(root / 'install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        safety['regular'](root / 'install.lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        identity = dict(config, node=NODE_VERSION, node_sha256=NODE_SHA256, acpx=ACPX_VERSION,
                        payload_sha256=hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest())
        key = config['release_tag'] + '-' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:20]

        def status(state, error=None):
            safety['write_json'](root / 'status.json', {
                'state': state, 'error': error, 'requested': key, 'versions': {
                    'opencode': config['release_tag'], 'node': NODE_VERSION, 'acpx': ACPX_VERSION},
                'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'active': os.readlink(root / 'active') if (root / 'active').is_symlink() else None})

        stage = None
        activated = False
        previous = None
        try:
            status('installing')
            prerequisites()
            for name in ('versions', 'bin', 'runtime'):
                safety['directory'](root / name, create=True)
            # Refuse foreign wrappers before any downloads or active switch.
            for tool in ('opencode', 'acpx'):
                path = root / 'bin' / tool
                if os.path.lexists(path):
                    safety['regular'](path)
                    if path.read_text() != wrapper(root, tool):
                        raise ValueError('existing command belongs to another installation')
            active = root / 'active'
            if os.path.lexists(active):
                if not active.is_symlink() or not re.fullmatch(r'versions/v\d+\.\d+\.\d+-ricky\.[1-9]\d*-[0-9a-f]{20}', os.readlink(active)):
                    raise ValueError('foreign active path')
                safety['directory'](active.resolve())
                previous = os.readlink(active)
            version = root / 'versions' / key
            if os.path.lexists(version):
                safety['directory'](version)
                safety['regular'](version / 'installed.json')
                manifest = json.loads((version / 'installed.json').read_text())
                if manifest['identity'] != identity or manifest['files'] != inventory(version):
                    raise ValueError('cached installation verification failed')
                check_versions(version, config['release_tag'])
            else:
                stage = Path(tempfile.mkdtemp(prefix='.staging-', dir=root / 'versions'))
                home = safety['directory'](stage / 'install-home', create=True)
                env = clean_env(home)
                release = stage / 'release.tar.gz'
                download('https://github.com/Ricky-Hao/opencode/releases/download/' + config['release_tag'] + '/' + config['release_asset'],
                         release, config['release_sha256'], env)
                release_dir = safety['directory'](stage / 'release', create=True)
                extract(release, release_dir)
                if {p.name for p in release_dir.iterdir()} != {'opencode', 'LICENSE', 'metadata.json'}:
                    raise ValueError('unexpected release contents')
                for name in ('opencode', 'LICENSE', 'metadata.json'):
                    safety['regular'](release_dir / name)
                    shutil.move(release_dir / name, stage / name)
                metadata = json.loads((stage / 'metadata.json').read_text())
                if (metadata.get('version') != config['release_tag'][1:] or metadata.get('target') != TARGET
                        or metadata.get('repository') != 'Ricky-Hao/opencode'
                        or metadata.get('source_tag') != config['release_tag'] or metadata.get('source_dirty') is not False
                        or not re.fullmatch(r'[0-9a-f]{40}', metadata.get('source_commit', ''))
                        or metadata.get('binary_sha256') != digest(stage / 'opencode')):
                    raise ValueError('release provenance mismatch')
                release.unlink()
                release_dir.rmdir()
                node_archive = stage / 'node.tar.xz'
                download(NODE_URL, node_archive, NODE_SHA256, env)
                node = safety['directory'](stage / 'node', create=True)
                extract(node_archive, node, node=True)
                node_archive.unlink()
                for name, content in files.items():
                    (stage / name).write_text(content)
                safety['write_json'](stage / 'settings.json', config)
                subprocess.run([str(node / 'bin/node'), str(node / 'lib/node_modules/npm/bin/npm-cli.js'),
                                'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                               cwd=stage, env=clean_env(home, node), check=True, timeout=600,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                shutil.rmtree(home)
                check_versions(stage, config['release_tag'])
                safety['write_json'](stage / 'installed.json', {'identity': identity, 'files': inventory(stage)})
                stage.rename(version)
                stage = None
            # All generated runtime data is workspace-private. Never serialize the caller environment.
            for name in ('home', 'config', 'data', 'cache', 'state', 'tmp'):
                safety['directory'](root / 'runtime' / name, create=True)
            acpx = safety['directory'](root / 'runtime/home/.acpx', create=True)
            if not os.path.lexists(acpx / 'config.json'):
                safety['write_json'](acpx / 'config.json', {
                    'defaultAgent': 'opencode', 'defaultPermissions': 'deny-all',
                    'nonInteractivePermissions': 'deny', 'authPolicy': 'skip',
                    'agents': {'opencode': {'argv': [str(root / 'bin/opencode'), 'acp']}}})
            else:
                safety['regular'](acpx / 'config.json')
            for tool in ('opencode', 'acpx'):
                path = root / 'bin' / tool
                if not path.exists():
                    with path.open('x') as stream:
                        stream.write(wrapper(root, tool))
                    path.chmod(0o700)
            temp = root / ('.active-' + str(os.getpid()))
            temp.symlink_to('versions/' + key)
            try:
                os.replace(temp, active)
                activated = True
            finally:
                temp.unlink(missing_ok=True)
            shell_path['install'](user_home, str(root / 'bin'))
            status('ready')
            print('OpenCode and acpx installation verified; status: ' + str(root / 'status.json'))
        except BaseException as exc:
            if activated:
                if previous is None:
                    active.unlink()
                else:
                    rollback = root / ('.rollback-' + str(os.getpid()))
                    rollback.symlink_to(previous)
                    os.replace(rollback, active)
            # Error categories only: URLs, subprocess output and env values may contain credentials.
            status('failed', type(exc).__name__)
            raise
        finally:
            if stage is not None:
                shutil.rmtree(stage)


def main():
    def interrupted(signum, frame):
        raise InterruptedError('installation interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        install(BUNDLE)
    except BaseException as exc:
        if isinstance(exc, UnsupportedPlatform):
            print('Unsupported platform: OpenCode requires Linux x64 glibc.', file=sys.stderr)
        print('OpenCode install failed (' + type(exc).__name__ + '); check prerequisites, ownership and private status.json.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
