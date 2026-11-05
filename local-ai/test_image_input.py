import base64
import unittest

from image_input import decode_image_bytes


def encoded(mime, raw):
    return f"data:image/{mime};base64," + base64.b64encode(raw).decode("ascii")


class ImageInputTests(unittest.TestCase):
    def test_supported_headers(self):
        for mime, raw in [("png", b"\x89PNG\r\n\x1a\n1234"), ("jpeg", b"\xff\xd8\xff1234"), ("webp", b"RIFF1234WEBP1234")]:
            with self.subTest(mime=mime):
                self.assertEqual(decode_image_bytes(encoded(mime, raw)), raw)

    def test_rejects_non_image_and_mismatched_mime(self):
        for value in [None, "", encoded("svg+xml", b"<svg/>"), encoded("jpeg", b"\x89PNG\r\n\x1a\n"), encoded("png", b"not a photo")]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    decode_image_bytes(value)

    def test_rejects_invalid_base64(self):
        for payload in ["!invalid", "AAA", "AAAA===", "AAAA\nAAAA"]:
            with self.assertRaises(ValueError):
                decode_image_bytes("data:image/png;base64," + payload)

    def test_limits_decoded_size_including_padding(self):
        raw = b"\x89PNG\r\n\x1a\n1234"
        self.assertEqual(decode_image_bytes(encoded("png", raw), max_bytes=12), raw)
        with self.assertRaises(ValueError):
            decode_image_bytes(encoded("png", raw), max_bytes=11)
        with self.assertRaises(ValueError):
            decode_image_bytes("data:image/png;base64," + "A" * 100, max_bytes=12)


if __name__ == "__main__":
    unittest.main()
