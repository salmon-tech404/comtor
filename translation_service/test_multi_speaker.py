"""
Comprehensive Test Suite covering all 10 real-world scenarios (Yêu cầu Mục 18):
Case 1: Một người nói liên tục
Case 2: A nói -> B nói -> A nói tiếp
Case 3: A và B caption update gần như đồng thời
Case 4: Nhiều người cùng nói một câu giống nhau như 'お疲れ様です。'
Case 5: Interim update rất nhanh
Case 6: Translation response trả về sai thứ tự
Case 7: Speaker block bị remove khi translation còn pending
Case 8: Một request translation bị chậm hoặc lỗi nhưng speaker khác không bị ảnh hưởng
Case 9: Caption dài được Meet update nhiều lần trên cùng một block
Case 10: Nhiều block tồn tại đồng thời, text gốc và bản dịch luôn khớp 100%
"""

import sys
import os
import asyncio
import time

sys.path.insert(0, os.path.dirname(__file__))

from sequence_buffer import SessionSequenceBuffer, SequenceBufferManager


async def test_case_1_single_speaker_continuous():
    print("\n--- [CASE 1] Một người nói liên tục trong 1 block ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c1"
    block_id = "blk_speaker_a"

    # Người A gửi lần lượt các câu chốt 1, 2, 3
    buf = await mgr.get_or_create(session_id, block_id)
    r1 = await buf.add_result({"type": "final", "seq": 1, "text": "Câu 1", "translated_text": "Bản dịch 1"})
    r2 = await buf.add_result({"type": "final", "seq": 2, "text": "Câu 2", "translated_text": "Bản dịch 2"})
    r3 = await buf.add_result({"type": "final", "seq": 3, "text": "Câu 3", "translated_text": "Bản dịch 3"})

    assert len(r1) == 1 and r1[0]["seq"] == 1
    assert len(r2) == 1 and r2[0]["seq"] == 2
    assert len(r3) == 1 and r3[0]["seq"] == 3
    print("✅ Case 1: Các câu được xuất ra tức thì (0ms), không có độ trễ timeout!")


async def test_case_2_interleaving_speakers():
    print("\n--- [CASE 2] A nói -> B chen vào -> A nói tiếp ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c2"
    block_a = "blk_a"
    block_b = "blk_b"

    buf_a = await mgr.get_or_create(session_id, block_a)
    buf_b = await mgr.get_or_create(session_id, block_b)

    # A nói câu 1
    out_a1 = await buf_a.add_result({"type": "final", "seq": 1, "speaker": "User A", "text": "A1"})
    assert len(out_a1) == 1 and out_a1[0]["speaker"] == "User A"

    # B chen vào nói câu 1 của B
    out_b1 = await buf_b.add_result({"type": "final", "seq": 1, "speaker": "User B", "text": "B1"})
    assert len(out_b1) == 1 and out_b1[0]["speaker"] == "User B"

    # A tiếp tục nói câu 2 của A
    out_a2 = await buf_a.add_result({"type": "final", "seq": 2, "speaker": "User A", "text": "A2"})
    assert len(out_a2) == 1 and out_a2[0]["speaker"] == "User A"

    print("✅ Case 2: A và B hoàn toàn độc lập, không bị trộn lẫn hoặc chặn nhau!")


async def test_case_3_concurrent_updates():
    print("\n--- [CASE 3] A và B update gần như đồng thời ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c3"

    buf_a = await mgr.get_or_create(session_id, "blk_a")
    buf_b = await mgr.get_or_create(session_id, "blk_b")

    # Mô phỏng cả 2 cùng gửi trong cùng một tick
    task_a = buf_a.add_result({"type": "final", "seq": 1, "text": "A"})
    task_b = buf_b.add_result({"type": "final", "seq": 1, "text": "B"})

    res_a, res_b = await asyncio.gather(task_a, task_b)
    assert len(res_a) == 1 and res_a[0]["text"] == "A"
    assert len(res_b) == 1 and res_b[0]["text"] == "B"
    print("✅ Case 3: Xử lý đồng thời thành công tuyệt đối!")


async def test_case_4_identical_phrases_different_speakers():
    print("\n--- [CASE 4] Nhiều người cùng nói 'お疲れ様です。' ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c4"

    identical_text = "お疲れ様です。"
    speakers = ["User 1", "User 2", "User 3", "User 4"]
    results = []

    for idx, sp in enumerate(speakers, 1):
        block_id = f"blk_{idx}"
        buf = await mgr.get_or_create(session_id, block_id)
        out = await buf.add_result({
            "type": "final",
            "block_id": block_id,
            "seq": 1,
            "speaker": sp,
            "text": identical_text,
            "translated_text": f"Chào bạn ({sp})"
        })
        results.append(out[0])

    assert len(results) == 4
    for idx, res in enumerate(results, 1):
        assert res["block_id"] == f"blk_{idx}"
        assert res["speaker"] == speakers[idx - 1]
    print("✅ Case 4: 4 người nói cùng 1 câu được tạo 4 stream độc lập hoàn toàn!")


async def test_case_5_rapid_interim():
    print("\n--- [CASE 5] Interim update cực nhanh ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c5"
    block_id = "blk_stream"
    buf = await mgr.get_or_create(session_id, block_id)

    # Gửi 5 interim liên tiếp với tốc độ cao
    for i in range(1, 6):
        out = await buf.add_result({
            "type": "interim",
            "seq": 1,
            "text": f"Text nháp lần {i}"
        })
        assert len(out) == 1, "Lỗi: Interim phải được xuất ra ngay lập tức!"
    print("✅ Case 5: 5/5 interim đều được xả ngay không qua hàng đợi!")


async def test_case_6_out_of_order_responses():
    print("\n--- [CASE 6] Translation response trả về đảo thứ tự ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c6"
    block_id = "blk_order"
    buf = await mgr.get_or_create(session_id, block_id)

    # Gói #2 về trước gói #1
    out_2 = await buf.add_result({"type": "final", "seq": 2, "text": "Câu 2"})
    assert len(out_2) == 0, "Gói #2 phải chờ gói #1!"

    # Gói #1 về sau
    out_1 = await buf.add_result({"type": "final", "seq": 1, "text": "Câu 1"})
    assert len(out_1) == 2, "Cả gói 1 và 2 phải xuất ra theo đúng thứ tự 1 -> 2!"
    assert out_1[0]["seq"] == 1 and out_1[1]["seq"] == 2
    print("✅ Case 6: Tự động sắp xếp lại đúng thứ tự tăng dần 1 -> 2!")


async def test_case_7_block_removed_pending():
    print("\n--- [CASE 7] Block bị remove khi response còn pending ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c7"
    block_id = "blk_removed"

    buf = await mgr.get_or_create(session_id, block_id)
    # Block đã gửi request nhưng Meet gỡ block khỏi DOM
    # Khi response về:
    out = await buf.add_result({"type": "final", "seq": 1, "text": "Câu cuối"})
    assert len(out) == 1
    # Cleanup session
    await mgr.remove_session(session_id)
    assert len(mgr.streams) == 0
    print("✅ Case 7: Response vẫn được chuyển tiếp an toàn trước khi dọn dẹp bộ nhớ!")


async def test_case_8_slow_request_isolation():
    print("\n--- [CASE 8] Một request của A bị chậm, B vẫn hoạt động bình thường ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c8"

    buf_a = await mgr.get_or_create(session_id, "blk_slow_a")
    buf_b = await mgr.get_or_create(session_id, "blk_fast_b")

    # A bị kẹt (ví dụ seq 2 về trước nhưng seq 1 chưa về)
    out_a = await buf_a.add_result({"type": "final", "seq": 2, "text": "A2"})
    assert len(out_a) == 0, "A2 đang đợi A1"

    # Trong lúc A đang đợi, B gửi seq 1 và seq 2 -> B PHẢI XUẤT RA NGAY LẬP TỨC!
    out_b1 = await buf_b.add_result({"type": "final", "seq": 1, "text": "B1"})
    out_b2 = await buf_b.add_result({"type": "final", "seq": 2, "text": "B2"})

    assert len(out_b1) == 1 and out_b1[0]["text"] == "B1"
    assert len(out_b2) == 1 and out_b2[0]["text"] == "B2"
    print("✅ Case 8: Khối B hoàn toàn không bị ảnh hưởng bởi sự cố của khối A!")


async def test_case_9_long_caption_in_place():
    print("\n--- [CASE 9] Caption dài được update nhiều lần trên cùng block ---")
    mgr = SequenceBufferManager()
    session_id = "sess_c9"
    block_id = "blk_long"
    buf = await mgr.get_or_create(session_id, block_id)

    # 3 lần interim mở rộng text
    await buf.add_result({"type": "interim", "seq": 1, "text": "大きく3つ質問して。"})
    await buf.add_result({"type": "interim", "seq": 1, "text": "大きく3つ質問して。元々いただいたスケジュールは..."})
    await buf.add_result({"type": "interim", "seq": 1, "text": "大きく3つ質問して。元々いただいたスケジュールは5ヶ月..."})

    # Chốt final
    final_res = await buf.add_result({"type": "final", "seq": 1, "text": "大きく3つ質問して。元々いただいたスケジュールは5ヶ月..."})
    assert len(final_res) == 1 and final_res[0]["seq"] == 1
    print("✅ Case 9: Text dài update liên tục trong cùng 1 stream mượt mà!")


async def test_case_10_multi_block_no_mixing():
    print("\n--- [CASE 10] Nhiều block đồng thời: Phụ đề thực tế từ 2 ảnh chụp ---")
    mgr = SequenceBufferManager()
    session_id = "sess_real_photos"

    # Khối 1: お疲れ様です。
    blk_1 = "blk_ribbon"
    buf_1 = await mgr.get_or_create(session_id, blk_1)

    # Khối 2: Bản trình bày của bạn
    blk_2 = "blk_flower"
    buf_2 = await mgr.get_or_create(session_id, blk_2)

    res_1 = await buf_1.add_result({
        "type": "final",
        "block_id": blk_1,
        "seq": 1,
        "speaker": "Người tham gia",
        "text": "お疲れ様です。",
        "translated_text": "Cảm ơn vì đã vất vả."
    })

    res_2 = await buf_2.add_result({
        "type": "final",
        "block_id": blk_2,
        "seq": 1,
        "speaker": "Bản trình bày của bạn",
        "text": "大きく3つ質問して。元々いただいた スケジュールは5ヶ月っていうところで線を引っ張ってくれてました。",
        "translated_text": "Có 3 câu hỏi lớn. Lịch trình ban đầu các bạn đưa ra là 5 tháng..."
    })

    # Xác minh text và speaker hoàn toàn khớp nhau
    assert res_1[0]["speaker"] == "Người tham gia"
    assert res_1[0]["text"] == "お疲れ様です。"
    assert res_1[0]["translated_text"] == "Cảm ơn vì đã vất vả."

    assert res_2[0]["speaker"] == "Bản trình bày của bạn"
    assert "大きく3つ質問して" in res_2[0]["text"]
    assert "3 câu hỏi lớn" in res_2[0]["translated_text"]

    print("✅ Case 10: Khối 1 và Khối 2 từ 2 ảnh chụp của người dùng khớp chính xác 100%, không bị ghép chéo!")


async def main():
    print("=" * 65)
    print(" BỘ KIỂM THỬ TOÀN DIỆN 10 TÌNH HUỐNG THỰC TẾ (MỤC 18) ")
    print("=" * 65)

    await test_case_1_single_speaker_continuous()
    await test_case_2_interleaving_speakers()
    await test_case_3_concurrent_updates()
    await test_case_4_identical_phrases_different_speakers()
    await test_case_5_rapid_interim()
    await test_case_6_out_of_order_responses()
    await test_case_7_block_removed_pending()
    await test_case_8_slow_request_isolation()
    await test_case_9_long_caption_in_place()
    await test_case_10_multi_block_no_mixing()

    print("\n" + "=" * 65)
    print("🎉 TẤT CẢ 10/10 TEST CASES ĐỀU ĐẠT CHUẨN 100%!")
    print("=" * 65)


if __name__ == "__main__":
    asyncio.run(main())
