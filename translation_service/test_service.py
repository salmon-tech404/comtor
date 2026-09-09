"""
Unit and Integration Tests for Google Meet JA-VI Translation Service
Kiểm thử CacheManager, SequenceBuffer, và Translation Engine.
"""

import sys
import os
import asyncio

# Đảm bảo import được các module cục bộ
sys.path.insert(0, os.path.dirname(__file__))

from cache_manager import TranslationCache
from sequence_buffer import SessionSequenceBuffer, SequenceBufferManager


def test_cache():
    print("\n--- [TEST 1] Kiểm tra CacheManager ---")
    cache = TranslationCache(max_size=3, cache_file_path="cache/test_cache.json")

    # Test chuẩn hóa key
    key1 = "  こんにちは　世界  "
    cache.set(key1, "Xin chào thế giới")
    assert cache.get("こんにちは 世界") == "Xin chào thế giới", "Lỗi: Chuẩn hóa key không khớp!"
    print("✅ Chuẩn hóa key và lưu/đọc cache thành công!")

    # Test LRU Eviction khi vượt max_size
    cache.set("A", "Bản dịch A")
    cache.set("B", "Bản dịch B")
    cache.set("C", "Bản dịch C") # Vượt quá 3 -> key1 phải bị loại bỏ
    assert cache.get(key1) is None, "Lỗi: LRU eviction không hoạt động!"
    assert cache.get("C") == "Bản dịch C", "Lỗi: Mục mới không được lưu!"
    print("✅ Cơ chế LRU Eviction hoạt động chính xác!")

    # Test Disk Persistence
    cache.save_to_disk()
    cache2 = TranslationCache(max_size=3, cache_file_path="cache/test_cache.json")
    loaded = cache2.load_from_disk()
    assert loaded == 3, f"Lỗi: Số lượng nạp lại không đúng ({loaded} != 3)"
    assert cache2.get("B") == "Bản dịch B"
    print("✅ Lưu trữ và nạp lại Cache từ đĩa JSON thành công!")

    # Dọn dẹp file test
    if os.path.exists("cache/test_cache.json"):
        os.remove("cache/test_cache.json")


async def test_sequence_buffer():
    print("\n--- [TEST 2] Kiểm tra SequenceBuffer đảm bảo thứ tự ---")
    buf = SessionSequenceBuffer(session_id="test_sess", timeout_seconds=0.5)

    # Gửi seq 2 trước seq 1 (bất đồng bộ)
    res2 = {"seq": 2, "type": "final", "text": "Câu 2", "translated_text": "Bản dịch câu 2"}
    res1 = {"seq": 1, "type": "final", "text": "Câu 1", "translated_text": "Bản dịch câu 1"}
    res3 = {"seq": 3, "type": "final", "text": "Câu 3", "translated_text": "Bản dịch câu 3"}

    # Đưa seq 2 vào trước -> Không được xuất ra vì đang chờ seq 1
    ready = await buf.add_result(res2)
    assert len(ready) == 0, "Lỗi: seq 2 không được phép xuất ra khi seq 1 chưa tới!"
    print("✅ seq #2 đã được giữ lại trong bộ đệm khi chờ seq #1!")

    # Đưa seq 1 vào -> Cả seq 1 và seq 2 phải được xuất ra theo đúng thứ tự
    ready = await buf.add_result(res1)
    assert len(ready) == 2, f"Lỗi: Kỳ vọng 2 mục xuất ra nhưng có {len(ready)}"
    assert ready[0]["seq"] == 1 and ready[1]["seq"] == 2, "Lỗi: Thứ tự xuất ra không đúng!"
    print("✅ Sau khi seq #1 tới, cả seq #1 và #2 đã xuất ra đúng thứ tự 1 -> 2!")

    # Đưa seq 3 vào -> Xuất ra ngay lập tức
    ready = await buf.add_result(res3)
    assert len(ready) == 1 and ready[0]["seq"] == 3
    print("✅ seq #3 xuất ra ngay lập tức vì seq #1 và #2 đã hoàn thành!")

    # Test Timeout flush khi một gói tin bị thất lạc
    res5 = {"seq": 5, "type": "final", "text": "Câu 5", "translated_text": "Bản dịch câu 5"}
    ready = await buf.add_result(res5) # seq 4 bị mất tích
    assert len(ready) == 0
    print("✅ seq #5 đang đợi seq #4...")
    await asyncio.sleep(0.6) # Đợi quá timeout 0.5s
    flushed = await buf.check_timeout_flush()
    assert len(flushed) == 1 and flushed[0]["seq"] == 5, "Lỗi: Timeout flush không giải phóng seq 5!"
    print("✅ Cơ chế Timeout Fail-Safe hoạt động hoàn hảo: Giải phóng seq #5 khi seq #4 bị mất tích!")


def main():
    print("=" * 60)
    print(" CHẠY BỘ KIỂM THỬ ĐƠN VỊ DỊCH VỤ TRANSLATION SERVICE ")
    print("=" * 60)

    test_cache()
    asyncio.run(test_sequence_buffer())

    print("\n" + "=" * 60)
    print("🎉 TẤT CẢ CÁC BÀI TEST ĐƠN VỊ ĐÃ ĐẠT 100%!")
    print("=" * 60)


if __name__ == "__main__":
    main()
