"""Offline regression tests; no Telegram, browser, or database credentials."""
import ast
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, MagicMock
from urllib.parse import urlparse

source = Path(__file__).resolve().parents[1] / 'scripts/shoob_archive_scraper.py'
tree = ast.parse(source.read_text())
names = {'TelegramError', 'api', 'download_media', 'archive'}
selected = ast.Module(body=[n for n in tree.body if getattr(n, 'name', '') in names], type_ignores=[])


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.requests = MagicMock()
        self.requests.RequestException = ConnectionError
        self.ns = dict(requests=self.requests, time=Mock(), os=os, urlparse=urlparse,
                       TOKEN='test', ARCHIVE_CHAT='1', BASE='https://shoob.gg')
        exec(compile(selected, str(source), 'exec'), self.ns)
        self.card = dict(name='Test', series='Test', tier=6, source_url='https://shoob.gg/cards/info/test',
                         media_url='https://shoob.gg/images/cards/test.png', media_type='image')

    def download(self, content):
        response = Mock()
        response.iter_content.return_value = [content]
        session = self.requests.Session.return_value.__enter__.return_value
        session.get.return_value.__enter__.return_value = response
        return self.ns['download_media'](self.card)

    def test_download_rejects_html_and_empty(self):
        for content in (b'', b'<html>Access denied</html>'):
            with self.assertRaises(RuntimeError): self.download(content)

    def test_gif_detected_from_content(self):
        self.assertEqual(self.download(b'GIF89a' + b'x' * 20)[1][2], 'animation')

    def test_url_rejection_uploads_bytes(self):
        err = self.ns['TelegramError']
        api = Mock(side_effect=[err('Bad Request: failed to get HTTP URL content'),
                                {'animation': {'file_id': 'saved'}, 'message_id': 7}])
        self.ns['api'] = api
        self.ns['download_media'] = Mock(return_value=(b'GIF89aDATA', ('gif', 'image/gif', 'animation')))
        self.assertEqual(self.ns['archive'](self.card), ('saved', 'animation', 7))
        self.assertEqual(api.call_args.args[0], 'sendAnimation')
        self.assertEqual(api.call_args.kwargs['files']['animation'][1], b'GIF89aDATA')

    def test_permissions_do_not_trigger_download(self):
        self.ns['api'] = Mock(side_effect=self.ns['TelegramError']('Forbidden: bot was kicked'))
        download = self.ns['download_media'] = Mock()
        with self.assertRaises(self.ns['TelegramError']): self.ns['archive'](self.card)
        download.assert_not_called()

    def test_400_does_not_retry_six_times(self):
        response = self.requests.post.return_value
        response.ok = False; response.status_code = 400
        response.json.return_value = {'ok': False, 'description': 'failed to get HTTP URL content'}
        with self.assertRaises(self.ns['TelegramError']): self.ns['api']('sendPhoto', {})
        self.assertEqual(self.requests.post.call_count, 1)

    def test_rate_limit_retries_multipart_bytes(self):
        first = Mock(ok=False, status_code=429)
        first.json.return_value = {'ok': False, 'parameters': {'retry_after': 2}}
        second = Mock(ok=True)
        second.json.return_value = {'ok': True, 'result': {'message_id': 1}}
        self.requests.post.side_effect = [first, second]
        files = {'photo': ('card.jpg', b'bytes', 'image/jpeg')}
        self.ns['api']('sendPhoto', {}, files)
        self.ns['time'].sleep.assert_called_once_with(3)
        for call in self.requests.post.call_args_list:
            self.assertEqual(call.kwargs['files'], files)


if __name__ == '__main__': unittest.main()
