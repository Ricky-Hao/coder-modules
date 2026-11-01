"""Module Git SSH: preserve caller identity; remember the presented host key.

OpenSSH KnownHostsCommand supplies the actual lookup host (including port/alias)
and negotiated public key. No keyscan, auth fallback or connection retry.
"""
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

from safety import directory, regular

BASE = 'OPENCODE_MODULE_GIT_SSH_BASE'
TRUST_OPTIONS = {'knownhostscommand', 'updatehostkeys', 'verifyhostkeydns'}


def environment(child, root, version):
    child = dict(child)
    if BASE not in child:
        child[BASE] = child.get('GIT_SSH_COMMAND') or shlex.quote(child.get('GIT_SSH', 'ssh'))
    child['GIT_SSH_COMMAND'] = shlex.join(['python3', '-B', str(version / 'git_ssh.py'), str(root / 'runtime/git')])
    return child


def validate_options(base, arguments):
    # Caller known_hosts/strictness remain intact; the hook supplies the current
    # key after those files are read. Do not compose other hooks or write to them.
    words = shlex.split(base)
    if not words or any(word in (';', '&&', '||', '|', '>', '<') for word in words):
        raise ValueError('OPTIONS_UNSUPPORTED')
    words += arguments
    explicit = set()
    for index, word in enumerate(words):
        option = words[index + 1] if word == '-o' and index + 1 < len(words) else word[2:] if word.startswith('-o') else ''
        name = re.split(r'[=\s]', option.lower(), 1)[0]
        explicit.add(name)
        if name in TRUST_OPTIONS:
            raise ValueError('OPTIONS_UNSUPPORTED')
    if os.environ.get('GIT_SSH_VARIANT', 'ssh') != 'ssh':
        raise ValueError('OPTIONS_UNSUPPORTED')
    return explicit


def remember(store, reason, host, kind, key):
    if reason == 'ORDER':
        return
    if reason not in ('HOSTNAME', 'ADDRESS') or not re.fullmatch(r'[A-Za-z0-9_.:\[\]-]{1,512}', host):
        raise ValueError('TRUST_FAILED')
    if kind not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521') or not re.fullmatch(r'[A-Za-z0-9+/]{20,16384}={0,2}', key):
        raise ValueError('TRUST_FAILED')
    directory(store)
    target = store / 'known_hosts'
    regular(target)
    if target.stat().st_mode & 0o077 or target.stat().st_size > 1024 * 1024:
        raise ValueError('TRUST_FAILED')
    line = f'{host} {kind} {key}\n'
    previous = target.read_text()
    kept = []
    for old in previous.splitlines(keepends=True):
        parts = old.split()
        if len(parts) >= 3 and host in parts[0].split(','):
            others = [name for name in parts[0].split(',') if name != host]
            if others:
                kept.append(','.join(others) + ' ' + ' '.join(parts[1:]) + '\n')
        else:
            kept.append(old)
    content = ''.join(kept)
    if content and not content.endswith('\n'):
        content += '\n'
    content += line
    if content != previous:
        fd, temporary = tempfile.mkstemp(prefix='.host-', dir=store)
        try:
            with os.fdopen(fd, 'w') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            fd = os.open(store, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    sys.stdout.write(line)


def connect(store, arguments):
    base = os.environ.get(BASE, 'ssh')
    explicit = validate_options(base, arguments)
    command = [sys.executable, '-B', str(Path(__file__).resolve()), '_remember', str(store)]
    hook = shlex.join([part.replace('%', '%%') for part in command] + ['%I', '%H', '%t', '%K'])
    filename = str(store / 'known_hosts').replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
    defaults = {'KnownHostsCommand': hook, 'UserKnownHostsFile': '"' + filename + '"',
                'GlobalKnownHostsFile': 'none', 'StrictHostKeyChecking': 'yes', 'UpdateHostKeys': 'no', 'VerifyHostKeyDNS': 'no'}
    options = [word for name, value in defaults.items() if name.lower() not in explicit for word in ('-o', name + '=' + value)]
    # Keep the injected Coder gitssh command's shell semantics and all arguments.
    child = subprocess.Popen(['/bin/sh', '-c', 'exec ' + base + ' "$@"', 'module-git-ssh', *options, *arguments], stderr=subprocess.PIPE)
    diagnostic = bytearray()
    while chunk := child.stderr.read(4096):
        diagnostic.extend(chunk[:max(0, 16384 - len(diagnostic))])
    status = child.wait()
    if status:
        reason = 'HOST_KEY_VERIFICATION_FAILED' if re.search(rb'(?m)^Host key verification failed\.\r?$', diagnostic) else 'FAILED'
        print('OPENCODE_GIT_SSH_' + reason, file=sys.stderr)
    return status if status >= 0 else 128 - status


def main():
    try:
        if sys.argv[1:2] == ['_remember'] and len(sys.argv) == 7:
            remember(Path(sys.argv[2]), *sys.argv[3:])
            return 0
        return connect(Path(sys.argv[1]), sys.argv[2:])
    except (OSError, ValueError, IndexError) as error:
        reason = 'OPTIONS_UNSUPPORTED' if isinstance(error, ValueError) and str(error) == 'OPTIONS_UNSUPPORTED' else 'TRUST_FAILED'
        print('OPENCODE_GIT_SSH_' + reason, file=sys.stderr)
        return 255


if __name__ == '__main__':
    sys.exit(main())
