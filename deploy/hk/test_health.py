import subprocess
import unittest
from site_health import check_homepage, probe_active, HomepageMismatch


HTML = b'<html><head><link rel="canonical" href="https://stefanzhang.com/"></head><body>blog</body></html>'


class HealthTests(unittest.TestCase):
    def response(self, body=HTML, status=b'200', returncode=0):
        return lambda args, **kwargs: subprocess.CompletedProcess(args, returncode, body+b'\n'+status, b'')

    def test_valid_homepage(self):
        check_homepage(HTML, self.response())

    def test_redirect_and_error_are_not_health(self):
        for status in (b'301', b'302', b'404', b'503'):
            with self.subTest(status=status), self.assertRaises(RuntimeError):
                check_homepage(HTML, self.response(status=status))

    def test_wrong_or_oversized_content(self):
        for body in (b'', b'ok', b'<html>error</html>', HTML.replace(b'.com/', b'.example/'), b'x'*1048577):
            with self.subTest(size=len(body)), self.assertRaises(RuntimeError):
                check_homepage(HTML, self.response(body=body))

    def test_transport_error(self):
        with self.assertRaises(RuntimeError):
            check_homepage(HTML, self.response(returncode=60))

    def test_local_tls_verified_no_redirect_follow(self):
        def request(args, **kwargs):
            self.assertIn('stefanzhang.cn:443:127.0.0.1', args)
            self.assertNotIn('--insecure', args)
            self.assertNotIn('--location', args)
            self.assertEqual(args[-1], 'https://stefanzhang.cn/')
            self.assertEqual(kwargs['timeout'], 10)
            return subprocess.CompletedProcess(args, 0, HTML+b'\n200', b'')
        check_homepage(HTML, request)

    def test_reload_window_resamples_and_retries_old_bytes(self):
        bodies = [b'<html>previous version</html>', HTML]
        sleeps = []
        def request(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, bodies.pop(0)+b'\n200', b'')
        probe_active(lambda: HTML, request, sleeps.append)
        self.assertEqual(sleeps, [1])
        self.assertEqual(bodies, [])

    def test_persistent_mismatch_fails_with_bounded_retries(self):
        sleeps = []
        with self.assertRaises(HomepageMismatch):
            probe_active(lambda: HTML, self.response(body=b'<html>wrong version</html>'), sleeps.append)
        self.assertEqual(sleeps, [1, 1])


if __name__ == '__main__':
    unittest.main()
