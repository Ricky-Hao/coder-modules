"""Synthetic agent identity, real flock and local HTTP only."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='task-activity-', dir=os.environ.get('TEST_TMP_ROOT'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.tasks = self.root / 'runtime/tasks-v3'
        self.tasks.mkdir(parents=True, mode=0o700)
        self.calls = []
        self.status = 200
        self.entered, self.release = threading.Event(), threading.Event()
        self.hold = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_PATCH(self):
                # Deliberately never record identity in fixture evidence.
                valid_identity = self.headers.get('Coder-Session-Token') == 'SYNTHETIC-AGENT-TOKEN'
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fixture.calls.append((self.path, valid_identity, body))
                fixture.entered.set()
                if fixture.hold:
                    fixture.release.wait(9)
                self.send_response(fixture.status)
                if fixture.status == 307:
                    self.send_header('Location', f'http://127.0.0.1:{fixture.server.server_port}/secret-redirect')
                self.end_headers()
                try:
                    self.wfile.write(b'SYNTHETIC-AGENT-TOKEN private error body')
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.settings = {'install_root': str(self.root), 'task_activity': {
            'url': f'http://127.0.0.1:{self.server.server_port}/', 'app_slug': 'opencode-tasks'}}
        for name in ('task_activity.py', 'diagnostics.py', 'safety.py'):
            shutil.copyfile(SCRIPTS / name, self.root / name)
            (self.root / name).chmod(0o600)
        self.write(self.root / 'settings.json', self.settings)

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def write(self, path, value):
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value))
        temporary.chmod(0o600)
        temporary.replace(path)

    def task(self, letter, phase='dispatched', locked=True):
        task = self.tasks / ('task_' + letter * 64)
        task.mkdir(mode=0o700)
        record = {'version': 3, 'id': task.name, 'phase': phase, 'dispatchedAt': 1}
        self.write(task / 'task.json', record)
        lock = (task / 'control.lock').open('w')
        (task / 'control.lock').chmod(0o600)
        if locked:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(lock.close)
        return task, record, lock

    def report(self, token=True):
        result = subprocess.run([sys.executable, '-B', str(self.root / 'task_activity.py')],
                                env={'PATH': '/usr/bin:/bin', **({'CODER_AGENT_TOKEN': 'SYNTHETIC-AGENT-TOKEN'} if token else {})},
                                capture_output=True, text=True, timeout=9)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertNotIn('SYNTHETIC-AGENT-TOKEN', result.stdout)
        self.assertNotIn('secret-redirect', result.stdout)
        return json.loads(result.stdout)

    def test_working_and_last_terminal_idle_with_exact_wire_contract(self):
        task, record, lock = self.task('a')
        self.assertEqual(self.report(), {'state': 'working'})
        record.update(phase='finished', result={'status': 'success'})
        self.write(task / 'task.json', record)
        self.assertEqual(self.report(), {'state': 'idle'})
        self.assertEqual(self.calls, [('/api/v2/workspaceagents/me/app-status', True, {
            'app_slug': 'opencode-tasks', 'state': state, 'message': 'OpenCode tasks ' + state}) for state in ('working', 'idle')])
        self.assertEqual(set(p.name for p in self.tasks.iterdir()), {task.name, '.activity.lock'})

    def test_concurrent_endings_and_stale_records_cannot_send_idle_over_live_work(self):
        first, a, lock = self.task('a')
        second, b, _ = self.task('b')
        self.task('c', locked=False)  # Crashed worker with dispatched on disk.
        a.update(phase='finished', result={'status': 'success'})
        self.write(first / 'task.json', a)
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: self.report(), range(2)))
        self.assertEqual(results, [{'state': 'working'}] * 2)
        b.update(phase='finished', result={'status': 'cancelled'})
        self.write(second / 'task.json', b)
        self.assertEqual(self.report(), {'state': 'idle'})

    def test_old_idle_is_serialized_before_new_working(self):
        self.task('a', phase='finished')
        self.hold = True
        with ThreadPoolExecutor(2) as pool:
            idle = pool.submit(self.report)
            self.assertTrue(self.entered.wait(2))
            self.task('b')
            working = pool.submit(self.report)
            time.sleep(0.1)
            self.assertEqual(len(self.calls), 1)
            self.release.set()
            self.assertEqual(idle.result(), {'state': 'idle'})
            self.assertEqual(working.result(), {'state': 'working'})
        self.assertEqual([call[2]['state'] for call in self.calls], ['idle', 'working'])

    def test_worker_lock_release_removes_stale_execution(self):
        _, _, lock = self.task('a')
        self.assertEqual(self.report(), {'state': 'working'})
        lock.close()
        self.assertEqual(self.report(), {'state': 'idle'})

    def test_unknown_and_cancel_intent_do_not_end_execution(self):
        task, _, _ = self.task('a')
        self.write(task / 'outbox.json', {'kind': 'no_progress', 'state': 'delivered'})
        self.write(task / 'cancel.request', {'requested': True})
        self.assertEqual(self.report(), {'state': 'working'})

    def test_disabled_and_missing_identity_never_request(self):
        self.assertEqual(self.report(token=False), {'error': 'identity_missing'})
        self.write(self.root / 'settings.json', {'install_root': str(self.root)})
        self.assertEqual(self.report(), {'disabled': True})
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.tasks.iterdir()), [])

    def test_http_errors_redirect_and_timeout_are_visible_without_secret_content(self):
        self.task('a')
        for status, reason in ((401, 'http'), (404, 'http'), (503, 'http'), (307, 'redirect')):
            self.status = status
            self.assertEqual(self.report(), {'error': reason, 'http_status': status})
        self.status, self.hold = 200, True
        start = time.monotonic()
        self.assertEqual(self.report(), {'error': 'timeout'})
        self.assertLess(time.monotonic() - start, 8)
        self.assertEqual(len(self.calls), 5)  # No redirect or retry.

    def test_lock_timeout_and_invalid_live_record_refuse_false_idle(self):
        self.task('a')
        with (self.tasks / '.activity.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.report(), {'error': 'lock_timeout'})
        (self.tasks / ('task_' + 'a' * 64) / 'task.json').write_text('broken')
        self.assertEqual(self.report(), {'error': 'local'})
        self.assertEqual(self.calls, [])

    def test_url_boundary_never_sends_identity_to_invalid_configuration(self):
        for url in ('http://coder.example.invalid', 'https://user:password@example.invalid',
                    'https://example.invalid?secret', 'https://example.invalid/#secret', 'https://example.invalid:bad'):
            self.settings['task_activity']['url'] = url
            self.write(self.root / 'settings.json', self.settings)
            self.assertIn(self.report()['error'], ('local', 'configuration'))
        self.assertEqual(self.calls, [])
