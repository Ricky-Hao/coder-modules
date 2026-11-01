"""Module Git only: current Coder gitssh/OpenSSH command, one host-key hook."""
import getopt
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
from safety import directory, sync_directory

BASE = 'OPENCODE_MODULE_GIT_SSH_BASE'


def environment(child, root):
    child = dict(child)
    if BASE not in child:
        child[BASE] = child.get('GIT_SSH_COMMAND') or shlex.quote(child.get('GIT_SSH', ''))
    child['GIT_SSH_COMMAND'] = shlex.join(['python3', '-B', str(Path(__file__).resolve()), str(root / 'runtime/git')])
    return child


def validate_options(base, arguments):
    # No shell or arbitrary wrappers. Coder's injected command is exactly
    # executable gitssh --; ordinary OpenSSH options use the stdlib short parser.
    if re.search(r'[$`;\n|&<>~*?]', base):
        raise ValueError()
    words = shlex.split(base)
    coder = words[1:3] == ['gitssh', '--']
    if not words or not coder and Path(words[0]).name != 'ssh' or os.environ.get('GIT_SSH_VARIANT', 'ssh') != 'ssh':
        raise ValueError()
    options, _ = getopt.getopt((words[3:] if coder else words[1:]) + arguments, 'vGTq46o:p:i:F:l:')
    explicit = {re.split(r'[=\s]', value.lower(), 1)[0] for flag, value in options if flag == '-o'}
    if explicit & {'knownhostscommand', 'updatehostkeys', 'verifyhostkeydns'}:
        raise ValueError()
    return words, explicit


def remember(store, reason, host, kind, key):
    if reason == 'ORDER' or kind.endswith('-cert-v01@openssh.com'):
        return  # Certificates retain native known_hosts/CA validation.
    if reason not in ('HOSTNAME', 'ADDRESS') or not re.fullmatch(r'[A-Za-z0-9_.:\[\]-]{1,512}', host):
        raise ValueError()
    if kind not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521') or not re.fullmatch(r'[A-Za-z0-9+/]{20,16384}={0,2}', key):
        raise ValueError()
    directory(store)
    line = f'{host} {kind} {key}\n'
    fd, temporary = tempfile.mkstemp(prefix='.host-', dir=store)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, store / (hashlib.sha256(host.encode()).hexdigest() + '.host'))
        sync_directory(store)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    sys.stdout.write(line)


def main():
    try:
        if sys.argv[1] == '_remember':
            remember(Path(os.environ['OPENCODE_GIT_TRUST']), *sys.argv[2:])
        else:
            words, explicit = validate_options(os.environ[BASE], sys.argv[2:])
            child = dict(os.environ, OPENCODE_GIT_VERSION=str(Path(__file__).resolve().parent), OPENCODE_GIT_TRUST=sys.argv[1])
            hook = shlex.join(['/usr/bin/env', 'python3', '-B', '-c',
                'import os,sys;sys.path.insert(0,os.environ["OPENCODE_GIT_VERSION"]);import git_ssh;sys.exit(git_ssh.main())',
                '_remember', '%I', '%H', '%t', '%K'])
            defaults = {'KnownHostsCommand': hook, 'StrictHostKeyChecking': 'yes', 'UpdateHostKeys': 'no', 'VerifyHostKeyDNS': 'no'}
            options = [word for name, value in defaults.items() if name.lower() not in explicit for word in ('-o', name + '=' + value)]
            # stderr may contain credentials. Drain without storing or echoing it.
            result = subprocess.run([*words, *options, *sys.argv[2:]], env=child, stderr=subprocess.DEVNULL)
            if result.returncode:
                print('OPENCODE_GIT_SSH_FAILED', file=sys.stderr)
            return result.returncode
        return 0
    except (OSError, ValueError, KeyError, IndexError, getopt.GetoptError):
        print('OPENCODE_GIT_SSH_OPTIONS_UNSUPPORTED', file=sys.stderr)
        return 255


if __name__ == '__main__':
    sys.exit(main())
