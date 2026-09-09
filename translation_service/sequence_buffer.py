"""
Sequence Buffer - Quản lý hàng đợi đảm bảo thứ tự trả về tăng dần của các câu FINAL.
Hỗ trợ đa luồng (Multi-Stream) theo từng Speaker Block: (session_id + block_id).
Các câu nháp INTERIM được trả về trực tiếp ngay lập tức, không bao giờ tham gia xếp hàng.
Ngăn chặn hiện tượng Người A nói dài làm kẹt kết quả của Người B.
"""

import time
import asyncio
from typing import Dict, Any, List, Optional


class SessionSequenceBuffer:
    def __init__(self, stream_id: Optional[str] = None, session_id: Optional[str] = None, timeout_seconds: float = 0.8):
        self.stream_id = stream_id or session_id or "default"
        self.timeout_seconds = timeout_seconds
        self.last_delivered_seq = 0
        self.buffer: Dict[int, Dict[str, Any]] = {}
        self.gap_start_time: Optional[float] = None
        self._lock = asyncio.Lock()

    async def add_result(self, result: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Thêm một kết quả dịch:
        - Nếu là 'interim': trả về ngay lập tức để hiển thị nháp tức thì.
        - Nếu là 'final': xếp theo thứ tự seq tăng dần, chỉ xuất ra khi đúng số thứ tự tiếp theo.
        """
        msg_type = result.get("type", "final")
        seq = result.get("seq", 0)

        # 1. Câu interim không bao giờ bị giữ lại, nhả về client ngay
        if msg_type == "interim":
            return [result]

        # 2. Xử lý câu final
        ready_items: List[Dict[str, Any]] = []

        async with self._lock:
            now = time.time()
            expected_next = self.last_delivered_seq + 1

            # Nếu seq đúng là số tiếp theo kỳ vọng (1, 2, 3...)
            if seq == expected_next:
                ready_items.append(result)
                self.last_delivered_seq = seq
                self.gap_start_time = None

                # Kiểm tra tiếp các seq đang đợi sẵn trong buffer
                while (self.last_delivered_seq + 1) in self.buffer:
                    self.last_delivered_seq += 1
                    ready_items.append(self.buffer.pop(self.last_delivered_seq))
            elif seq > expected_next:
                # Bị hổng một số thứ tự ở giữa -> lưu vào buffer chờ đợi
                self.buffer[seq] = result
                if self.gap_start_time is None:
                    self.gap_start_time = now
                print(f"[SequenceBuffer][{self.stream_id}] Đang đợi seq #{expected_next}, tạm giữ seq #{seq} trong bộ đệm.")
            else:
                # Gói tin đến trễ hoặc duplicate
                ready_items.append(result)

        return ready_items

    async def check_timeout_flush(self) -> List[Dict[str, Any]]:
        """
        Kiểm tra nếu một seq bị mất tích quá timeout_seconds thì giải phóng các câu sau
        """
        async with self._lock:
            now = time.time()
            if self.buffer and self.gap_start_time and (now - self.gap_start_time) > self.timeout_seconds:
                lowest_buffered_seq = min(self.buffer.keys())
                print(f"[SequenceBuffer][{self.stream_id}] Timeout flush: Nhảy cóc từ seq #{self.last_delivered_seq} lên #{lowest_buffered_seq}!")

                ready_items = []
                self.last_delivered_seq = lowest_buffered_seq - 1
                self.gap_start_time = None

                while (self.last_delivered_seq + 1) in self.buffer:
                    self.last_delivered_seq += 1
                    ready_items.append(self.buffer.pop(self.last_delivered_seq))
                return ready_items
            return []


class SequenceBufferManager:
    """
    Quản lý bộ đệm chuỗi độc lập cho từng Speaker Block trong phiên họp
    Key định danh: f"{session_id}:{block_id}"
    """
    def __init__(self):
        self.streams: Dict[str, SessionSequenceBuffer] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def make_stream_key(session_id: str, block_id: Optional[str]) -> str:
        b_id = block_id if block_id else "global"
        return f"{session_id}:{b_id}"

    async def get_or_create(self, session_id: str, block_id: Optional[str] = None) -> SessionSequenceBuffer:
        key = self.make_stream_key(session_id, block_id)
        async with self._lock:
            if key not in self.streams:
                self.streams[key] = SessionSequenceBuffer(stream_id=key)
            return self.streams[key]

    async def check_all_timeout_flushes(self, session_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Xả hàng đợi cho tất cả các stream của session này
        """
        flushed_items = []
        async with self._lock:
            active_keys = list(self.streams.keys())

        for key in active_keys:
            if session_id is None or key.startswith(f"{session_id}:"):
                stream_buf = self.streams.get(key)
                if stream_buf:
                    items = await stream_buf.check_timeout_flush()
                    if items:
                        flushed_items.extend(items)
        return flushed_items

    async def remove_session(self, session_id: str):
        prefix = f"{session_id}:"
        async with self._lock:
            keys_to_del = [k for k in self.streams if k.startswith(prefix) or k == session_id]
            for k in keys_to_del:
                del self.streams[k]
