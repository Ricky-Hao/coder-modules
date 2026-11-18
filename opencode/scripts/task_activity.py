#!/usr/bin/env python3
"""One bounded app-status request, serialized with other workers; no task writes."""
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urljoin
from urllib.request import HTTPRedirectHandler, Request, build_opener

from diagnostics import read_json


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def running(tasks):
    # A stale dispatched record cannot keep a workspace alive without a worker.
    for task in tasks.iterdir():
        if not re.fullmatch(r'task_[a-f0-9]{64}', task.name):
            continue
        try:
            fd = os.open(task / 'control.lock', os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            continue
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                record = read_json(task / 'task.json', 2 * 1024 * 1024)
                if record['version'] != 3 or record['id'] != task.name:
                    raise ValueError('invalid task')
                if record['phase'] == 'dispatched' and record.get('dispatchedAt') is not None and not record.get('result'):
                    return True
        finally:
            os.close(fd)
    return False


def report(settings, environ):
    config = settings.get('task_activity')
    if not config:
        return {'disabled': True}
    url, slug = config['url'], config['app_slug']
    parsed = urlsplit(url)
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.port == 0 or re.search(r'[\x00-\x20\x7f]', url)
            or not (parsed.scheme == 'https' or parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1'))
            or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug)):
        return {'error': 'configuration'}
    token = environ.get('CODER_AGENT_TOKEN')
    if not token:
        return {'error': 'identity_missing'}
    tasks = Path(settings['install_root']) / 'runtime/tasks-v3'
    fd = os.open(tasks / '.activity.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    return {'error': 'lock_timeout'}
                time.sleep(0.025)
        state = 'working' if running(tasks) else 'idle'
        body = json.dumps({'app_slug': slug, 'state': state, 'message': 'OpenCode tasks ' + state}).encode()
        request = Request(urljoin(url, '/api/v2/workspaceagents/me/app-status'), data=body, method='PATCH',
                          headers={'Content-Type': 'application/json', 'Coder-Session-Token': token})
        # Keep the lock through the response: an older idle cannot overtake working.
        try:
            with build_opener(NoRedirect()).open(request, timeout=5) as response:
                if response.status != 200:
                    return {'error': 'http', 'http_status': response.status}
        except HTTPError as error:
            error.close()  # Never read or expose server bodies/headers (including Location).
            return {'error': 'redirect' if 300 <= error.code < 400 else 'http', 'http_status': error.code}
        except TimeoutError:
            return {'error': 'timeout'}
        except URLError as error:
            return {'error': 'timeout' if isinstance(error.reason, TimeoutError) else 'network'}
        return {'state': state}
    finally:
        os.close(fd)


def expired(signum, frame):
    raise TimeoutError()


def main():
    # Includes DNS, lock wait and HTTP; Node also imposes a hard process timeout.
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(7)
    try:
        result = report(read_json(Path(__file__).resolve().parent / 'settings.json'), os.environ)
    except TimeoutError:
        result = {'error': 'timeout'}
    except (OSError, ValueError, KeyError, TypeError):
        result = {'error': 'local'}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
