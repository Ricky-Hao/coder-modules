#!/usr/bin/env python3
"""One Git source for personal instructions and complete, shared skill packages."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

import git_ssh
from safety import ancestors, directory, owner, regular, sync_directory, write_json

REPOSITORY = 'ssh://git@git.rickyhao.com:2222/RickyHao/agent-config.git'
REF = 'refs/heads/main'
NETWORK_SECONDS = 6
LOCK_SECONDS = 8


class SyncError(ValueError):
    pass


def git(arguments, env, deadline, data=None):
    # Kill the SSH descendants too; a connection/auth helper must not outlive the bound.
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SyncError('unavailable')
    with subprocess.Popen(['git', *arguments], env=env, stdin=subprocess.PIPE if data else subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True) as process:
        try:
            stdout, _ = process.communicate(data, timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise SyncError('unavailable') from None
        if process.returncode:
            raise SyncError('unavailable')
        return stdout


def inventory(repo):
    result = {}
    directory(repo)
    for path in sorted(repo.rglob('*')):
        if path.is_symlink():
            raise SyncError('unsafe_cache')
        if path.is_dir():
            directory(path)
        else:
            regular(path, single_link=path != repo / 'AGENTS.md')
            result[path.relative_to(repo).as_posix()] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                                        'mode': stat.S_IMODE(path.stat().st_mode)}
    return result


def cached(store):
    current = store / 'current'
    if not os.path.lexists(current):
        return None
    if not current.is_symlink() or not re.fullmatch(r'snapshots/[0-9a-f]{40}/repo', os.readlink(current)):
        raise SyncError('unsafe_cache')
    repo = store / os.readlink(current)
    directory(repo.parent)
    regular(repo.parent / 'manifest.json')
    if inventory(repo) != json.loads((repo.parent / 'manifest.json').read_text()):
        raise SyncError('cache_modified')
    return repo


def link_target(path, target):
    if os.path.lexists(path) and (not path.is_symlink() or os.readlink(path) != str(target)):
        raise SyncError('target_conflict')


def replace_link(path, target):
    temporary = path.parent / ('.agent-config-' + os.urandom(8).hex())
    temporary.symlink_to(str(target))
    try:
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def instruction_target(path, store):
    if not os.path.lexists(path):
        return
    regular(path, single_link=False)
    candidates = [store / 'current/AGENTS.md']
    state = store / 'state.json'
    if state.exists():
        regular(state)
        tree = json.loads(state.read_text()).get('tree', '')
        if re.fullmatch(r'[0-9a-f]{40}', tree):
            candidates.append(store / 'snapshots' / tree / 'repo/AGENTS.md')
    if not any(candidate.exists() and path.samefile(candidate) for candidate in candidates):
        raise SyncError('target_conflict')


def publish_instruction(path, repo):
    if path.exists() and path.samefile(repo / 'AGENTS.md'):
        return
    # A real file at the global path keeps native instruction discovery/watch identity stable.
    temporary = path.parent / ('.agent-config-' + os.urandom(8).hex())
    os.link(repo / 'AGENTS.md', temporary)
    try:
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def snapshot(store, cache, revision, env, deadline):
    tree = git(['--git-dir', str(cache), 'rev-parse', revision + '^{tree}'], env, deadline).decode().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', tree):
        raise SyncError('invalid_source')
    destination = store / 'snapshots' / tree
    if destination.exists():
        regular(destination / 'manifest.json')
        if inventory(destination / 'repo') != json.loads((destination / 'manifest.json').read_text()):
            raise SyncError('cache_modified')
        return destination / 'repo'
    stage = Path(tempfile.mkdtemp(prefix='.staging-', dir=store / 'snapshots'))
    try:
        # Export raw Git blobs: archive/checkout can omit or transform files via attributes/filters.
        entries = git(['--git-dir', str(cache), 'ls-tree', '-rz', tree], env, deadline).split(b'\0')[:-1]
        files = []
        for entry in entries:
            header, name = entry.split(b'\t', 1)
            mode, kind, blob = header.split()
            relative = PurePosixPath(name.decode())
            if (mode not in (b'100644', b'100755') or kind != b'blob' or relative.is_absolute()
                    or '..' in relative.parts or not relative.parts):
                raise SyncError('invalid_source')
            files.append((relative, mode, blob))
        objects = git(['--git-dir', str(cache), 'cat-file', '--batch'], env, deadline,
                      b''.join(blob + b'\n' for _, _, blob in files))
        repo = directory(stage / 'repo', create=True)
        cursor = 0
        for relative, mode, blob in files:
            end = objects.index(b'\n', cursor)
            actual, kind, size = objects[cursor:end].split()
            start, cursor = end + 1, end + 1 + int(size)
            if actual != blob or kind != b'blob' or objects[cursor:cursor + 1] != b'\n':
                raise SyncError('invalid_source')
            path = repo / relative
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with path.open('xb') as output:
                output.write(objects[start:cursor])
                output.flush()
                os.fsync(output.fileno())
            path.chmod(0o700 if mode == b'100755' else 0o600)
            cursor += 1
        if not (repo / 'AGENTS.md').read_text().strip() or not list((repo / 'skills').glob('*/SKILL.md')):
            raise SyncError('invalid_source')
        write_json(stage / 'manifest.json', inventory(repo))
        for path in sorted((p for p in repo.rglob('*') if p.is_dir()), reverse=True):
            sync_directory(path)
        sync_directory(repo)
        sync_directory(stage)
        stage.rename(destination)
        sync_directory(destination.parent)
        return destination / 'repo'
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def refresh(store, env, old):
    deadline = time.monotonic() + NETWORK_SECONDS
    remote = git(['ls-remote', '--exit-code', REPOSITORY, REF], env, deadline).decode().split()
    if len(remote) != 2 or not re.fullmatch(r'[0-9a-f]{40}', remote[0]) or remote[1] != REF:
        raise SyncError('invalid_source')
    revision = remote[0]
    state = store / 'state.json'
    if state.exists():
        regular(state)
        if old and json.loads(state.read_text()) == {'revision': revision, 'tree': old.parent.name}:
            return revision, old
    cache = store / 'git'
    if not cache.exists():
        git(['init', '--bare', '--quiet', str(cache)], env, deadline)
    directory(cache)
    git(['--git-dir', str(cache), 'fetch', '--quiet', '--depth=1', '--no-tags', REPOSITORY, REF], env, deadline)
    # main can advance between lookup and fetch: use exactly the fetched main, never a guessed object.
    fetched = git(['--git-dir', str(cache), 'rev-parse', 'FETCH_HEAD'], env, deadline).decode().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', fetched):
        raise SyncError('invalid_source')
    repo = snapshot(store, cache, fetched, env, deadline)
    return fetched, repo


def codex_directory(path):
    # Codex's existing directories can be readable; never chmod or adopt writable shared paths.
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise SyncError('target_conflict')
    return path


def synchronize(root, workspace, environ, codex_home=None):
    """Only mutate the shared config/cache; never inspect or operate on business tasks."""
    ancestors(root)
    owner(root, workspace)
    directory(root / 'runtime')
    store = directory(root / 'runtime/agent-config', create=True)
    directory(store / 'snapshots', create=True)
    lockpath = store / 'sync.lock'
    fd = os.open(lockpath, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        regular(lockpath)
        deadline = time.monotonic() + LOCK_SECONDS
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise SyncError('busy')
                time.sleep(0.05)
        config = root / 'runtime/config/opencode'
        directory(config.parent)
        directory(config, create=True)
        skills = directory(config / 'skills', create=True)
        instruction_target(config / 'AGENTS.md', store)
        targets = {skills / 'agent-config': store / 'current/skills'}
        if codex_home is not None:
            if not codex_home.is_absolute() or '..' in codex_home.parts:
                raise SyncError('target_conflict')
            ancestors(codex_home)
            codex_directory(codex_home)
            if os.path.lexists(codex_home / 'AGENTS.override.md'):
                raise SyncError('target_conflict')
            codex_skills = codex_directory(codex_home / 'skills')
            targets.update({codex_home / 'AGENTS.md': store / 'current/AGENTS.md',
                            codex_skills / 'agent-config': store / 'current/skills'})
        for path, target in targets.items():
            link_target(path, target)
        old = cached(store)
        env = git_ssh.environment(dict(environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never'), root)
        directory(root / 'runtime/git', create=True)
        try:
            revision, repo = refresh(store, env, old)
        except (OSError, SyncError, UnicodeError) as error:
            if not old:
                raise SyncError('unavailable_no_cache') from None
            if isinstance(error, SyncError) and str(error) not in ('unavailable', 'invalid_source'):
                raise
            repo = old
            state = json.loads((store / 'state.json').read_text()) if (store / 'state.json').exists() else {}
            revision = state.get('revision') if state.get('tree') == old.parent.name else None
            print('agent-config: sync unavailable; using complete cached rules and skills.', file=sys.stderr)
        changed = old != repo
        try:
            if changed:
                replace_link(store / 'current', repo.relative_to(store))
            publish_instruction(config / 'AGENTS.md', repo)
            for path, target in targets.items():
                if changed or not os.path.lexists(path):
                    replace_link(path, target)
            state = {'revision': revision, 'tree': repo.parent.name}
            if not (store / 'state.json').exists() or json.loads((store / 'state.json').read_text()) != state:
                write_json(store / 'state.json', state)
                sync_directory(store)
        except OSError:
            if changed and old:
                replace_link(store / 'current', old.relative_to(store))
                publish_instruction(config / 'AGENTS.md', old)
            raise
        return state
    finally:
        os.close(fd)


def report(error):
    reason = str(error) if isinstance(error, SyncError) else 'unsafe_state'
    print(json.dumps({'error': {'code': 'AGENT_CONFIG_SYNC_FAILED', 'stage': 'agent_config', 'reason': reason,
                               'action': 'check_agent_config', 'hint': '中心规则同步失败；检查 Git 身份、网络及托管目标。未执行原命令。'}},
                     ensure_ascii=False), file=sys.stderr)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-home', type=Path, help='Explicit Codex config directory; no agent is installed or run')
    args = parser.parse_args()
    os.umask(0o077)
    settings = json.loads(Path(__file__).with_name('settings.json').read_text())
    try:
        value = synchronize(Path(settings['install_root']), settings['workspace_id'], os.environ, args.codex_home)
    except (OSError, ValueError, KeyError, TypeError) as error:
        report(error)
        return 1
    print(json.dumps(value))
    return 0


if __name__ == '__main__':
    sys.exit(main())
