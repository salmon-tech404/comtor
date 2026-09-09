"""
Sequence Buffer - Quản lý hàng đợi đảm bảo thứ tự trả về tăng dần của sequence number.
Ngăn chặn hiện tượng bất đồng bộ khiến câu dịch sau lại xuất hiện trước câu dịch trước.
Có cơ chế Timeout Fail-Safe tránh deadlock nếu một gói tin bị thất lạc.
"""

import time
import asyncio
from typing import Dict, Any, List, Optional


class SessionSequenceBuffer:
    def __init__(self, session_id: str, timeout_seconds: float = 1.5):
        self.session_id = session_id
        self.timeout_seconds = timeout_seconds
        self.expected_seq = 1
        self.buffer: Dict[int, Dict[str, Any]] = {}
        self.last_advance_time = time.time()
        self._lock = asyncio.Lock()

    async def add_result(self, result: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Thêm một kết quả dịch vào bộ đệm sắp xếp, và trả về danh sách các kết quả
        sẵn sàng để gửi đi theo đúng thứ tự tăng dần liên tục của seq.
        """
        seq = result.get("seq", 0)
        msg_type = result.get("type", "final")

        ready_items: List[Dict[str, Any]] = []

        async with self._lock:
            now = time.time()

            # Nếu là câu tạm thời (interim), cho phép gửi nhanh nếu không quá cũ
            if msg_type == "interim":
                if seq >= self.expected_seq - 1:
                    return [result]
                return []

            # Lưu vào buffer theo seq
            self.buffer[seq] = result

            # Kiểm tra cơ chế fail-safe: Nếu expected_seq đợi quá lâu mà không tới
            # trong khi có các seq lớn hơn đang xếp hàng đợi
            if self.expected_seq not in self.buffer and self.buffer:
                lowest_buffered_seq = min(self.buffer.keys())
                if (now - self.last_advance_time) > self.timeout_seconds and lowest_buffered_seq > self.expected_seq:
                    print(f"[SequenceBuffer] Cảnh báo: seq #{self.expected_seq} bị trễ quá {self.timeout_seconds}s. Nhảy cóc lên seq #{lowest_buffered_seq} để tránh nghẽn!")
                    self.expected_seq = lowest_buffered_seq
                    self.last_advance_time = now

            # Xả tất cả các kết quả liên tục từ expected_seq trở đi
            while self.expected_seq in self.buffer:
                item = self.buffer.pop(self.expected_seq)
                ready_items.append(item)
                self.expected_seq += 1
                self.last_advance_time = now

        return ready_items

    async def check_timeout_flush(self) -> List[Dict[str, Any]]:
        """
        Được gọi định kỳ để xả hàng đợi nếu đang bị nghẽn bởi seq mất tích
        """
        async with self._lock:
            now = time.time()
            if self.buffer and (now - self.last_advance_time) > self.timeout_seconds:
                lowest_buffered_seq = min(self.buffer.keys())
                print(f"[SequenceBuffer] Timeout flush: giải phóng từ seq #{lowest_buffered_seq}")
                self.expected_seq = lowest_buffered_seq
                self.last_advance_time = now

                ready_items = []
                while self.expected_seq in self.buffer:
                    item = self.buffer.pop(self.expected_seq)
                    ready_items.append(item)
                    self.expected_seq += 1
                return ready_items
            return []


class SequenceBufferManager:
    """
    Quản lý bộ đệm chuỗi cho nhiều phiên họp (session) khác nhau
    """
    def __init__(self):
        self.sessions: Dict[str, SessionSequenceBuffer] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, session_id: str) -> SessionSequenceBuffer:
        async with self._lock:
            if session_id not in self.sessions:
                self.sessions[session_id] = SessionSequenceBuffer(session_id)
            return self.sessions[session_id]

    async def remove_session(self, session_id: str):
        async with self._lock:
            if session_id in self.sessions:
                del self.sessions[session_id]
