import importlib.util
import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


def load_hotmail_helper():
    module_path = Path(__file__).resolve().parents[1] / "scripts" / "hotmail_helper.py"
    spec = importlib.util.spec_from_file_location("hotmail_helper", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hotmail_helper = load_hotmail_helper()


class HotmailHelperLoggingTest(unittest.TestCase):
    def test_select_latest_code_can_use_full_body_when_preview_is_truncated(self):
        css_prefix = (
            'Your temporary ChatGPT verification code '
            '@font-face { font-family: "Söhne"; src: url(https://cdn.openai.com/common/fonts/soehne/soehne-buch.woff2) format("woff2"); } '
            '.ExternalClass { width: 100%; } '
            '#bodyTable { width: 560px; } '
            'body { min-width: 100% !important; } '
        ) * 8
        full_body = (
            css_prefix
            + 'Enter this temporary verification code to continue: 272964 '
            + 'Please ignore this email if this was not you.'
        )
        message = {
            "id": "imap-1",
            "mailbox": "INBOX",
            "subject": "Your temporary ChatGPT verification code",
            "from": {
                "emailAddress": {
                    "address": "otp@tm1.openai.com",
                    "name": "OpenAI",
                }
            },
            "bodyPreview": full_body[:500],
            "body": {
                "content": full_body,
            },
            "receivedTimestamp": 200,
        }

        result = hotmail_helper.select_latest_code(
            [message],
            ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'],
            ['verify', 'verification', 'code', '验证码', 'confirm', 'login'],
            [],
            0,
        )

        self.assertEqual(result["code"], "272964")
        self.assertEqual(result["message"]["id"], "imap-1")

    def test_log_openai_messages_logs_full_body_when_available(self):
        messages = [{
            "mailbox": "INBOX",
            "subject": "Your verification code",
            "from": {
                "emailAddress": {
                    "address": "account-security@openai.com",
                    "name": "OpenAI",
                }
            },
            "bodyPreview": "Use 123456 to continue.",
            "body": {
                "content": "Hello there\nUse 123456 to continue.",
            },
        }]

        output = io.StringIO()
        with redirect_stdout(output):
            hotmail_helper.log_openai_messages(messages, transport="imap")

        rendered = output.getvalue()
        self.assertIn(
            "[HotmailHelper] openai mail received transport=imap mailbox=INBOX sender=account-security@openai.com senderName=OpenAI subject=Your verification code",
            rendered,
        )
        self.assertIn(
            "[HotmailHelper] openai mail full body start transport=imap mailbox=INBOX sender=account-security@openai.com senderName=OpenAI subject=Your verification code",
            rendered,
        )
        self.assertIn("Hello there\nUse 123456 to continue.", rendered)
        self.assertIn("[HotmailHelper] openai mail full body end", rendered)

    def test_log_openai_messages_falls_back_to_preview_without_full_body(self):
        messages = [{
            "mailbox": "Junk",
            "subject": "Verify your sign in",
            "from": {
                "emailAddress": {
                    "address": "noreply@tm.openai.com",
                    "name": "ChatGPT",
                }
            },
            "bodyPreview": "Use 654321 to continue.",
        }]

        output = io.StringIO()
        with redirect_stdout(output):
            hotmail_helper.log_openai_messages(messages, transport="graph")

        rendered = output.getvalue()
        self.assertIn(
            "[HotmailHelper] openai mail received transport=graph mailbox=Junk sender=noreply@tm.openai.com senderName=ChatGPT subject=Verify your sign in",
            rendered,
        )
        self.assertIn(
            "[HotmailHelper] openai mail preview transport=graph mailbox=Junk sender=noreply@tm.openai.com senderName=ChatGPT subject=Verify your sign in preview=Use 654321 to continue.",
            rendered,
        )
        self.assertNotIn("openai mail full body start", rendered)

    def test_refresh_access_token_logs_invalid_grant_and_direct_connection_refused_separately(self):
        failures = [
            {
                "ok": False,
                "endpoint": "entra-common-delegated",
                "url": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                "status": 400,
                "error": '{"error":"invalid_grant","error_description":"AADSTS70000"}',
                "elapsed_ms": 101,
            },
            {
                "ok": False,
                "endpoint": "entra-consumers-delegated",
                "url": "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
                "status": None,
                "error": "Token request failed: <urlopen error [Errno 61] Connection refused>",
                "elapsed_ms": 88,
            },
        ]

        with mock.patch.object(hotmail_helper, "try_refresh_access_token", side_effect=failures), \
             mock.patch.object(hotmail_helper, "get_proxy_debug_context", return_value="direct"):
            output = io.StringIO()
            with redirect_stdout(output):
                with self.assertRaises(RuntimeError):
                    hotmail_helper.refresh_access_token(
                        "client-id-demo",
                        "refresh-token-demo",
                        ["entra-common-delegated", "entra-consumers-delegated"],
                    )

        rendered = output.getvalue()
        self.assertIn("category=invalid_grant", rendered)
        self.assertIn("category=connection_refused", rendered)

    def test_graph_and_outlook_message_urls_are_encoded(self):
        captured_urls = []

        def fake_get_json(url, headers=None):
            captured_urls.append(url)
            return 200, {"value": []}

        with mock.patch.object(hotmail_helper, "get_json", side_effect=fake_get_json):
            hotmail_helper.fetch_graph_messages("access-token-demo", mailbox="INBOX", top=5)
            hotmail_helper.fetch_outlook_api_messages("access-token-demo", mailbox="INBOX", top=5)

        self.assertEqual(len(captured_urls), 2)
        self.assertTrue(all(" " not in url for url in captured_urls))
        self.assertIn("%24orderby=receivedDateTime+desc", captured_urls[0])
        self.assertIn("%24orderby=ReceivedDateTime+desc", captured_urls[1])

    def test_sync_chatgpt_session_snapshots_writes_json_file(self):
        target = Path(__file__).resolve().parents[1] / "data" / ".test-chatgpt-session-snapshots.json"
        try:
            with mock.patch.object(hotmail_helper, "CHATGPT_SESSION_SNAPSHOT_PATH", str(target)):
                file_path = hotmail_helper.sync_chatgpt_session_snapshots({
                    "snapshots": [{
                        "id": "saved@example.com:1",
                        "savedAt": "2026-05-06T00:00:00Z",
                        "accountIdentifierType": "email",
                        "accountIdentifier": "saved@example.com",
                        "email": "saved@example.com",
                        "password": "pw",
                        "sessionStatus": 200,
                        "session": {"user": {"email": "saved@example.com"}},
                    }],
                })

            self.assertEqual(file_path, str(target))
            payload = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(payload["count"], 1)
            self.assertEqual(payload["snapshots"][0]["email"], "saved@example.com")
            self.assertEqual(payload["snapshots"][0]["session"]["user"]["email"], "saved@example.com")
        finally:
            target.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
