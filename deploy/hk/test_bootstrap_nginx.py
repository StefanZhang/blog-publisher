"""Exercise rendered bootstrap vhosts in an isolated, loopback-only Nginx."""
import http.client
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import unittest
import bootstrap

NGINX = os.environ.get('NGINX_BIN') or shutil.which('nginx')
OPENSSL = shutil.which('openssl')


@unittest.skipUnless(NGINX and OPENSSL, 'real nginx and openssl are required')
class BootstrapNginxTests(unittest.TestCase):
    def test_rendered_vhost_preserves_body_and_canonicalizes_entrypoints(self):
        old = (Path(__file__).parent/'fixtures/legacy-vhost.conf').read_text()
        vhost, legacy = bootstrap.render_vhost(old)
        self.assertIn('include '+bootstrap.BASE+'/active/nginx/server.conf;', vhost)
        self.assertIn('root '+bootstrap.BASE+'/'+bootstrap.CURRENT+';', legacy)
        with tempfile.TemporaryDirectory(prefix='cn-bootstrap-nginx-') as directory:
            root = Path(directory).resolve()
            site, acme = root/'site', root/'acme/.well-known/acme-challenge'
            site.mkdir(); acme.mkdir(parents=True); (root/'logs').mkdir()
            body = b'<!doctype html><title>Preserved</title><p>same legacy bytes</p>'
            (site/'index.html').write_bytes(body); (acme/'probe').write_bytes(b'acme-proof')
            (root/'health').write_bytes(b'ok\n')
            subprocess.run([OPENSSL, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(root/'key.pem'), '-out', str(root/'cert.pem'),
                            '-days', '1', '-subj', '/CN=stefanzhang.cn'],
                           check=True, capture_output=True, timeout=30)
            sockets = [socket.socket(), socket.socket()]
            try:
                for sock in sockets: sock.bind(('127.0.0.1', 0))
                http_port, tls_port = [sock.getsockname()[1] for sock in sockets]
            finally:
                for sock in sockets: sock.close()
            replacements = {
                bootstrap.BASE+'/active/nginx/server.conf': str(root/'server.conf'),
                bootstrap.BASE+'/'+bootstrap.CURRENT: str(site),
                '/var/www/acme': str(root/'acme'), '/var/log/nginx/': str(root/'logs')+'/',
                '/var/lib/static-node-monitor/ok': str(root/'health'),
                '/etc/letsencrypt/live/stefanzhang.cn/fullchain.pem': str(root/'cert.pem'),
                '/etc/letsencrypt/live/stefanzhang.cn/privkey.pem': str(root/'key.pem'),
            }
            def relocate(text):
                for source, target in replacements.items(): text = text.replace(source, target)
                text = re.sub(r'listen \[::\]:(?:80|443)[^;]*;', '', text)
                return re.sub(r'listen (80|443)([^;]*);', lambda m: 'listen 127.0.0.1:'+
                              str(http_port if m[1] == '80' else tls_port)+m[2]+';', text)
            (root/'server.conf').write_text(relocate(legacy))
            config = ('daemon off; master_process off; pid '+str(root/'nginx.pid')+';\n'
                      'error_log '+str(root/'error.log')+'; events { worker_connections 32; }\n'
                      'http { access_log off; default_type text/html; '+relocate(vhost)+'\n}\n')
            (root/'nginx.conf').write_text(config)
            args = [NGINX, '-p', str(root)+'/', '-c', str(root/'nginx.conf')]
            syntax = subprocess.run(args+['-t'], capture_output=True, text=True, timeout=10)
            self.assertEqual(syntax.returncode, 0, syntax.stdout+syntax.stderr)
            def request(port, host, target, tls=False):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                if tls:
                    connection.sock = ssl._create_unverified_context().wrap_socket(
                        socket.create_connection(('127.0.0.1', port), timeout=3), server_hostname=host)
                try:
                    connection.request('GET', target, headers={'Host': host})
                    response = connection.getresponse()
                    return response.status, response.getheader('Location'), response.read()
                finally: connection.close()
            with (root/'process.log').open('w') as log:
                process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
                try:
                    for attempt in range(50):
                        try: request(http_port, 'stefanzhang.cn', '/'); break
                        except OSError: time.sleep(.1)
                    else: self.fail('isolated nginx did not start: '+(root/'process.log').read_text())
                    for host in ['stefanzhang.cn', 'www.stefanzhang.cn']:
                        with self.subTest(http_host=host):
                            self.assertEqual(request(http_port, host, '/?p=21')[:2],
                                             (301, 'https://stefanzhang.cn/?p=21'))
                            self.assertEqual(request(http_port, host, '/.well-known/acme-challenge/probe'),
                                             (200, None, b'acme-proof'))
                    self.assertEqual(request(tls_port, 'www.stefanzhang.cn', '/?p=21', True)[:2],
                                     (301, 'https://stefanzhang.cn/?p=21'))
                    self.assertEqual(request(tls_port, 'stefanzhang.cn', '/', True), (200, None, body))
                    self.assertEqual(request(tls_port, 'stefanzhang.cn', '/healthz', True), (200, None, b'ok\n'))
                finally:
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
