#!/usr/bin/env python3
"""Check the served HTTPS homepage, without accepting HTTP redirects as health."""
from html.parser import HTMLParser
import hashlib
from pathlib import Path
import subprocess
import time


class HomepageMismatch(RuntimeError):
    pass


class Homepage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.html = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'html':
            self.html = True


def check_homepage(expected_body, run=subprocess.run):
    result = run([
        '/usr/bin/curl', '--silent', '--show-error', '--max-time', '8',
        '--max-filesize', '1048576', '--noproxy', '*',
        '--resolve', 'stefanzhang.cn:443:127.0.0.1',
        '--write-out', '\n%{http_code}', 'https://stefanzhang.cn/',
    ], capture_output=True, timeout=10, check=False)
    if result.returncode:
        raise RuntimeError('Local HTTPS homepage request failed')
    body, separator, status = result.stdout.rpartition(b'\n')
    if not separator or status != b'200' or not 1 <= len(body) <= 1048576:
        raise RuntimeError('Homepage must return HTTP 200 with bounded content')
    parsed = Homepage()
    parsed.feed(body.decode('utf8', errors='strict'))
    if not parsed.html:
        raise RuntimeError('Homepage is not HTML')
    if hashlib.sha256(body).digest() != hashlib.sha256(expected_body).digest():
        raise HomepageMismatch('Homepage differs from the active static file')


def active_homepage(root=Path('/var/www/stefanzhang.cn')):
    pointer = root/'active'
    source = pointer/'site/index.html' if pointer.is_symlink() else root/'current/index.html'
    resolved = source.resolve(strict=True)
    if not resolved.is_relative_to((root/'releases').resolve(strict=True)):
        raise RuntimeError('Homepage is outside immutable releases')
    if not 1 <= resolved.stat().st_size <= 1048576:
        raise RuntimeError('Unexpected homepage size')
    return resolved.read_bytes()


def probe_active(load=active_homepage, run=subprocess.run, sleep=time.sleep):
    # active is swapped just before nginx test/reload. During that short window
    # an old worker legitimately serves old bytes. Retry only this mismatch,
    # resampling active each time; transport/status failures are not suppressed.
    for attempt in range(3):
        try:
            check_homepage(load(), run)
            return
        except HomepageMismatch:
            if attempt == 2:
                raise
            sleep(1)


if __name__ == '__main__':
    try:
        probe_active()
    except Exception as error:
        raise SystemExit(str(error))
