"""Module-owned configuration with env-only endpoint/key references."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from urllib.parse import urlsplit

from safety import directory, regular

MCP_NAMES = ('CONTEXT7', 'FIRECRAWL', 'GITHUB', 'GITHUB_ACTIONS')
LLM_KEYS = ('LLM_API_KEY', 'LLM_BASE_URL')
PROFILE_KEYS = set(LLM_KEYS) | {
    f'{name}_MCP_{suffix}' for name in MCP_NAMES
    for suffix in ('URL', 'API_KEY', 'ENABLED', 'AUTH_HEADER', 'AUTH_SCHEME')}


class ProfileError(ValueError):
    """Only module-defined variable names are allowed in actionable diagnostics."""
    def __init__(self, reason, names):
        assert reason in ('missing', 'invalid') and set(names) <= PROFILE_KEYS
        super().__init__('Env profile: ' + reason + ' environment names: ' + ', '.join(sorted(names)))


def value(environ, name):
    result = environ.get(name, '')
    if not result:
        raise ProfileError('missing', [name])
    if not isinstance(result, str) or any(ord(c) < 32 or ord(c) > 126 or c in '"\\{}' for c in result):
        raise ProfileError('invalid', [name])
    return result


def endpoint(environ, name, allow_http=False):
    result = value(environ, name)
    try:
        parts = urlsplit(result)
        if (any(c.isspace() for c in result) or not parts.hostname or parts.username or parts.password
                or parts.query or parts.fragment or parts.port == 0
                or not (parts.scheme == 'https' or parts.scheme == 'http' and (
                    allow_http or parts.hostname in ('localhost', '127.0.0.1', '::1')))):
            raise ValueError()
    except ValueError:
        raise ProfileError('invalid', [name]) from None


def enabled_servers(environ):
    enabled = []
    for name in MCP_NAMES:
        flag = name + '_MCP_ENABLED'
        setting = environ.get(flag, '0')
        if setting not in ('0', '1'):
            raise ProfileError('invalid', [flag])
        if setting == '1':
            enabled.append(name)
    return enabled


def configuration(environ, version):
    """Validate only selected credentials; return settings with refs and allowed names."""
    enabled = enabled_servers(environ)
    required = set(LLM_KEYS) | {name + '_MCP_' + suffix for name in enabled for suffix in ('URL', 'API_KEY')}
    missing = [name for name in required if not environ.get(name)]
    if missing:
        raise ProfileError('missing', missing)
    value(environ, 'LLM_API_KEY')
    endpoint(environ, 'LLM_BASE_URL')
    config = json.loads((version / 'profile-env.json').read_text())
    servers = config['mcp']['servers']
    allowed = set(LLM_KEYS)
    for name in MCP_NAMES:
        prefix = name + '_MCP_'
        server_name = name.lower().replace('_', '-')
        if name not in enabled:
            del servers[server_name]
            continue
        endpoint(environ, prefix + 'URL', allow_http=True)
        value(environ, prefix + 'API_KEY')
        server = servers[server_name]
        header = environ.get(prefix + 'AUTH_HEADER', next(iter(server['headers'])))
        if not isinstance(header, str) or not re.fullmatch(r'[A-Za-z0-9-]+', header):
            raise ProfileError('invalid', [prefix + 'AUTH_HEADER'])
        scheme = environ.get(prefix + 'AUTH_SCHEME', 'Bearer' if header.lower() == 'authorization' else '')
        if not isinstance(scheme, str) or scheme and not re.fullmatch(r'[A-Za-z0-9]+', scheme):
            raise ProfileError('invalid', [prefix + 'AUTH_SCHEME'])
        server['headers'] = {header: (scheme + ' ' if scheme else '') + '{env:' + prefix + 'API_KEY}'}
        server['disabled'] = False
        # Controls must survive acpx -> opencode so the same profile is reconstructed.
        allowed.update(prefix + suffix for suffix in ('URL', 'API_KEY', 'ENABLED', 'AUTH_HEADER', 'AUTH_SCHEME'))
    return config, allowed


def private_file(path):
    regular(path)
    if stat.S_IMODE(path.lstat().st_mode) != 0o600:
        raise ValueError('managed profile file must be mode 0600')


def create_json(path, data):
    """Publish a complete 0600 file atomically, without replacing any existing name."""
    fd, temporary = tempfile.mkstemp(prefix='.profile-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)  # Exclusive publication; never overwrite user content.
    finally:
        os.unlink(temporary)


def encoded(config):
    return (json.dumps(config, sort_keys=True, indent=2) + '\n').encode()


def materialize(root, workspace_id, config):
    """Content-addressed files outside auto-discovery; none/external never load them."""
    parent = directory(root / 'runtime')
    store = root / 'runtime/module-profiles'
    # Lock the existing safe parent before creating either directory or marker.
    # A second first launch must not observe our temporarily unmarked directory.
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        created = False
        try:
            store.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        directory(store)
        marker = store / 'owner.json'
        identity = encoded({'schema': 1, 'kind': 'opencode-module-profiles',
                            'uid': os.getuid(), 'workspace_id': workspace_id})
        if created:
            create_json(marker, identity)
        private_file(marker)
        if marker.read_bytes() != identity:
            raise ValueError('unmanaged profile store')
        data = encoded(config)
        path = store / (hashlib.sha256(data).hexdigest() + '.json')
        if os.path.lexists(path):
            private_file(path)
            if path.read_bytes() != data:
                raise ValueError('unmanaged or changed profile file')
        else:
            create_json(path, data)
        store_fd = os.open(store, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(store_fd)
        finally:
            os.close(store_fd)
        os.fsync(fd)
        return path
    finally:
        os.close(fd)


def harmless(arguments):
    # Help/version never validate, retain profile credentials, or generate config.
    # Do not treat arbitrary prompts/arguments containing '--help' as introspection.
    return arguments in (['--version'], ['-v'], ['-V']) or bool(arguments) and arguments[-1] in ('--help', '-h') and all(
        re.fullmatch(r'[a-z][a-z0-9-]*', part) for part in arguments[:-1])


def information(profile, external, environ, version):
    """Local module introspection: no credential reads, file writes or service calls."""
    if external or profile == 'none':
        return {'source': 'external' if external else 'none', 'automatic_environment_names': []}
    if profile != 'env':
        raise ValueError('unknown runtime profile')
    selected = json.loads((version / 'profile-env.json').read_text())['model']
    enabled = enabled_servers(environ)
    return {'source': 'env', 'model': selected,
            'enabled_mcp': [name.lower().replace('_', '-') for name in enabled],
            'required_environment_names': sorted(set(LLM_KEYS) | {
                name + '_MCP_' + suffix for name in enabled for suffix in ('URL', 'API_KEY')})}
