"""Validate encoded image input before loading expensive vision dependencies."""

import base64
import binascii
import re

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000


def decode_image_bytes(data_url: str, *, max_bytes: int = MAX_IMAGE_BYTES) -> bytes:
    if not isinstance(data_url, str):
        raise ValueError("올바른 이미지 데이터가 아닙니다.")
    # Bound the encoded payload before allocating decoded bytes.
    if len(data_url) > ((max_bytes + 2) // 3) * 4 + 32:
        raise ValueError("사진은 8MB 이하로 올려주세요.")
    match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})", data_url)
    if not match:
        raise ValueError("JPEG, PNG, WebP 사진만 사용할 수 있습니다.")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("이미지 데이터가 손상되었습니다.") from error
    if len(raw) > max_bytes:
        raise ValueError("사진은 8MB 이하로 올려주세요.")
    kind = match.group(1)
    valid = (
        (kind == "jpeg" and raw.startswith(b"\xff\xd8\xff"))
        or (kind == "png" and raw.startswith(b"\x89PNG\r\n\x1a\n"))
        or (kind == "webp" and len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
    )
    if not valid:
        raise ValueError("사진의 형식과 내용이 일치하지 않습니다.")
    return raw
