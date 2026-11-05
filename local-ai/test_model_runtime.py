import threading
import time
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from model_runtime import ModelRuntime, SetupError, load_models


class RuntimeTests(unittest.TestCase):
    def wait(self, runtime, state):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if runtime.status()["state"] == state:
                return
            time.sleep(0.005)
        self.fail(f"runtime did not enter {state}")

    def test_health_is_available_during_loading_and_duplicate_warmup_is_ignored(self):
        release = threading.Event()
        calls = []
        def loader():
            calls.append(True)
            release.wait(1)
            return {"detector": "ready"}
        runtime = ModelRuntime(loader)
        self.assertTrue(runtime.start())
        self.assertFalse(runtime.start())
        self.assertEqual(runtime.status()["state"], "loading")
        self.assertFalse(runtime.status()["ready"])
        release.set()
        self.wait(runtime, "ready")
        self.assertEqual(runtime.get()["detector"], "ready")
        self.assertEqual(len(calls), 1)

    def test_failed_initialization_is_sanitized_and_can_retry(self):
        calls = []
        def loader():
            calls.append(True)
            if len(calls) == 1:
                raise RuntimeError("secret-file-system-token")
            return {"detector": "retry"}
        runtime = ModelRuntime(loader)
        runtime.start()
        self.wait(runtime, "error")
        self.assertNotIn("secret", runtime.status()["message"])
        with self.assertRaises(SetupError):
            runtime.get()
        runtime.start()
        self.wait(runtime, "ready")
        self.assertEqual(runtime.get()["detector"], "retry")

    def test_corrupt_background_cache_fails_before_import_or_network(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            face = cache / "face.tflite"
            face.write_bytes(b"\0\0\0\0TFL3" + b"\0" * 1024)
            background = cache / "models" / "u2net_human_seg" / "u2net_human_seg.onnx"
            background.parent.mkdir(parents=True)
            background.write_bytes(b"corrupt cached model")
            with patch("model_runtime.FACE_MODEL_PATH", face), patch("model_runtime.REMBG_HOME", cache), patch("model_runtime.urllib.request.urlopen") as network:
                with self.assertRaises(SetupError) as failure:
                    load_models(allow_download=False)
                self.assertEqual(failure.exception.code, "corrupt_model")
                network.assert_not_called()

    def test_missing_caches_do_not_download_or_import_heavy_models(self):
        with patch("model_runtime.cache_status", return_value={"face": False, "background": False}), patch("model_runtime.urllib.request.urlopen") as network:
            with self.assertRaises(SetupError) as failure:
                load_models()
            self.assertEqual(failure.exception.code, "missing_models")
            network.assert_not_called()


if __name__ == "__main__":
    unittest.main()
