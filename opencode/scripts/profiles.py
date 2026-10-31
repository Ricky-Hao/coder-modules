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
PROVIDERS = ('copilot', 'codex')
LLM_KEYS = tuple(name.upper() + suffix for name in PROVIDERS for suffix in ('_API_KEY', '_BASE_URL'))
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


def configuration(environ, version, provider='codex'):
    """Validate configured providers/enabled MCP; return settings with env references."""
    enabled = enabled_servers(environ)
    if provider not in PROVIDERS:
        raise ValueError('unknown env-profile provider')
    configured = [name for name in PROVIDERS if name == provider or any(
        environ.get(name.upper() + suffix) for suffix in ('_API_KEY', '_BASE_URL'))]
    required = {name.upper() + suffix for name in configured for suffix in ('_API_KEY', '_BASE_URL')} | {
        name + '_MCP_' + suffix for name in enabled for suffix in ('URL', 'API_KEY')}
    missing = [name for name in required if not environ.get(name)]
    if missing:
        raise ProfileError('missing', missing)
    for name in configured:
        value(environ, name.upper() + '_API_KEY')
        endpoint(environ, name.upper() + '_BASE_URL')
    config = json.loads((version / 'profile-env.json').read_text())
    servers = config['mcp']['servers']
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
    return config


def selection(model, variant=None):
    if isinstance(model, dict):
        variant = model.get('variant')
        model = model['providerID'] + '/' + model['model']
    if isinstance(model, str) and '#' in model:
        model, variant = model.split('#', 1)
    if not isinstance(model, str) or len(model) > 256 or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_./:-]+', model):
        raise ValueError('INVALID_MODEL')
    if variant is not None and (not isinstance(variant, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', variant)):
        raise ValueError('INVALID_VARIANT')
    return {'id': model, **({'variant': variant} if variant is not None else {})}


def task_configuration(config, model=None, variant=None):
    """Snapshot nonsecret task defaults, including title routing, before acceptance."""
    if model is not None and (not isinstance(model, str) or '#' in model):
        raise ValueError('INVALID_MODEL')
    selected = selection(model if model is not None else config.get('model'))
    provider, model_id = selected['id'].split('/', 1)
    definition = config.get('providers', {}).get(provider, {}).get('models', {}).get(model_id)
    if definition is None:
        raise ValueError('INVALID_MODEL')
    effort = variant if variant is not None else selected.get('variant', definition.get('settings', {}).get('reasoningEffort'))
    selected = selection(selected['id'], effort)
    if effort is not None and effort not in [item['id'] for item in definition.get('variants', [])]:
        raise ValueError('INVALID_VARIANT')
    config['model'] = {'providerID': provider, 'model': model_id, **({'variant': effort} if effort else {})}
    title = config.setdefault('agents', {}).setdefault('title', {})
    title_model = title.get('model', {}).get('model', model_id) if isinstance(title.get('model'), dict) else model_id
    title_definition = config['providers'][provider]['models'].get(title_model, definition)
    if title_model not in config['providers'][provider]['models']:
        title_model = model_id
    if 'low' not in [item['id'] for item in title_definition.get('variants', [])]:
        raise ValueError('TASK_TITLE_LOW_UNAVAILABLE')
    title['model'] = {'providerID': provider, 'model': title_model, 'variant': 'low'}
    return selected


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
    # Help/version skip profile validation and config generation; env still inherits.
    # Do not treat arbitrary prompts/arguments containing '--help' as introspection.
    return arguments in (['--version'], ['-v'], ['-V']) or bool(arguments) and arguments[-1] in ('--help', '-h') and all(
        re.fullmatch(r'[a-z][a-z0-9-]*', part) for part in arguments[:-1])


def information(profile, external, environ, version):
    """Local module introspection: no credential reads, file writes or service calls."""
    if external or profile == 'none':
        return {'source': 'external' if external else 'none', 'automatic_environment_names': []}
    if profile != 'env':
        raise ValueError('unknown runtime profile')
    from diagnostics import read_json
    selected = read_json(version / 'profile-env.json')['model']
    enabled = enabled_servers(environ)
    return {'source': 'env', 'model': selected,
            'enabled_mcp': [name.lower().replace('_', '-') for name in enabled],
            'provider_environment_names': list(LLM_KEYS),
            'required_environment_names': sorted({'CODEX_API_KEY', 'CODEX_BASE_URL'} | {
                name + '_MCP_' + suffix for name in enabled for suffix in ('URL', 'API_KEY')})}
