"""
Cache Manager - Quản lý bộ nhớ đệm bản dịch theo cơ chế LRU (Least Recently Used)
Hỗ trợ lưu trữ bền vững xuống đĩa (disk persistence) dưới dạng JSON.
"""

import os
import json
import re
import threading
from collections import OrderedDict
from typing import Optional


class TranslationCache:
    def __init__(self, max_size: int = 10000, cache_file_path: str = "cache/translations.json"):
        self.max_size = max_size
        self.cache_file_path = cache_file_path
        self._cache = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def normalize_key(text: str) -> str:
        """
        Chuẩn hóa văn bản tiếng Nhật làm khóa cache:
        - Chuyển đổi khoảng trắng toàn phần (full-width space \u3000) thành khoảng trắng thường
        - Rút gọn khoảng trắng liên tiếp
        - Cắt tỉa khoảng trắng đầu và cuối
        """
        if not text:
            return ""
        norm = text.replace("\u3000", " ")
        norm = re.sub(r"\s+", " ", norm)
        return norm.strip()

    def get(self, japanese_text: str) -> Optional[str]:
        """
        Lấy bản dịch từ cache nếu có. Nếu tìm thấy, di chuyển lên đầu (MRU).
        """
        key = self.normalize_key(japanese_text)
        if not key:
            return None

        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        return None

    def set(self, japanese_text: str, vietnamese_text: str) -> None:
        """
        Lưu bản dịch vào cache. Nếu vượt quá max_size, loại bỏ mục cũ nhất (LRU).
        """
        key = self.normalize_key(japanese_text)
        if not key or not vietnamese_text:
            return

        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = vietnamese_text.strip()

            if len(self._cache) > self.max_size:
                # Loại bỏ phần tử cũ nhất ở đầu OrderedDict (FIFO/LRU)
                self._cache.popitem(last=False)

    def load_from_disk(self) -> int:
        """
        Tải cache từ file JSON trên đĩa khi service khởi động.
        """
        if not os.path.exists(self.cache_file_path):
            return 0

        try:
            with open(self.cache_file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                with self._lock:
                    self._cache.clear()
                    # Giới hạn kích thước khi nạp
                    for k, v in list(data.items())[-self.max_size:]:
                        self._cache[k] = v
            print(f"[CacheManager] Đã nạp thành công {len(self._cache)} bản dịch từ {self.cache_file_path}")
            return len(self._cache)
        except Exception as e:
            print(f"[CacheManager] Lỗi khi nạp cache từ đĩa: {e}")
            return 0

    def save_to_disk(self) -> bool:
        """
        Lưu toàn bộ cache xuống file JSON trên đĩa khi service tắt.
        """
        try:
            os.makedirs(os.path.dirname(self.cache_file_path), exist_ok=True)
            with self._lock:
                data = dict(self._cache)

            with open(self.cache_file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"[CacheManager] Đã lưu {len(data)} bản dịch vào {self.cache_file_path}")
            return True
        except Exception as e:
            print(f"[CacheManager] Lỗi khi lưu cache xuống đĩa: {e}")
            return False

    def size(self) -> int:
        with self._lock:
            return len(self._cache)
