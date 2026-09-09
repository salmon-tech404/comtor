# Hệ Thống Dịch Phụ Đề Google Meet Nhật - Việt Thời Gian Thực (Real-time JA-VI Translator)

Hệ thống dịch song song phụ đề Google Meet (Closed Captions) từ tiếng Nhật sang tiếng Việt với độ trễ cực thấp (<40ms), sử dụng mô hình AI NLLB-200 tối ưu hóa qua CTranslate2 và tăng tốc phần cứng bằng NVIDIA GPU (CUDA float16).

---

## 🌟 Tính Năng Nổi Bật

1. **Bóc tách phụ đề Meet siêu ổn định (Phần 2)**:
   - Sử dụng thuộc tính trợ năng `aria-live="polite"` và `aria-live="assertive"` kết hợp bộ lọc tọa độ nửa dưới màn hình video.
   - Bóc tách chính xác tên người nói (ví dụ: `Yuki KOBAYASHI`, `You`...) và văn bản tiếng Nhật tương ứng.
   - Cơ chế Debounce 350ms thông minh: Tự động chốt câu khi người nói dừng lại hoặc khi Meet xóa trắng phụ đề (`text === ""`).

2. **Kiến trúc bền vững với Chrome Extension Manifest V3 (Phần 1 & 3)**:
   - Background Service Worker duy trì kết nối WebSocket liên tục tới máy chủ dịch địa phương `ws://127.0.0.1:8765/ws`.
   - Tự động kết nối lại theo cấp số nhân (Exponential Backoff `1s -> 2s -> 4s -> 8s -> 10s`) khi server khởi động lại.
   - Cơ chế Keep-Alive định kỳ chống trình duyệt tắt Service Worker giữa buổi họp.

3. **Giao diện Subtitle Overlay sang trọng (Phần 9 & 10)**:
   - Được đóng gói hoàn toàn trong **Shadow DOM**, ngăn ngừa triệt để việc xung đột CSS với Google Meet.
   - Nền tối Glassmorphism tương phản cao, dễ đọc trên mọi phông nền video.
   - Hỗ trợ kéo thả (Drag & Drop) tự do và tự động ghi nhớ vị trí trên màn hình qua `chrome.storage.local`.
   - Chế độ dịch câu nháp tức thì (**Interim Live Draft**) chữ nghiêng vàng giúp nắm bắt ý đồ người nói ngay khi chưa nói xong câu.
   - Tự động làm mờ và ẩn các dòng phụ đề cũ sau 25 giây.

4. **Công nghệ Dịch AI Tối Tân (Phần 5, 6, 7, 8)**:
   - Tận dụng sức mạnh GPU **NVIDIA GeForce RTX 4060** (`device="cuda"`, `compute_type="float16"`), tốc độ dịch chỉ ~20-40ms/câu.
   - Bộ đệm **LRU Cache** chuẩn hóa văn bản tiếng Nhật (bỏ khoảng trắng thừa), lưu trữ bền vững vào `cache/translations.json`. Trả kết quả Cache Hit tức thì `~0.1ms`.
   - Hàng đợi **Sequence Buffer**: Đảm bảo các câu dịch luôn xuất hiện đúng tuần tự hội thoại tăng dần, tích hợp cơ chế Timeout Fail-Safe chống tắc nghẽn (deadlock).

5. **Đo lường hiệu năng toàn trình (Phần 11)**:
   - Hiển thị nhãn thời gian thực thi (Latency Badge `[35ms]`) ngay trên từng thẻ phụ đề.
   - Terminal server in chi tiết log từng khâu (thời gian suy luận model, tổng thời gian xử lý, cache hit).

---

## 📁 Cấu Trúc Thư Mục Dự Án

```
d:\13-trans\
├── extension\                   # Toàn bộ mã nguồn Chrome Extension (Manifest V3)
│   ├── manifest.json            # Cấu hình extension MV3
│   ├── background.js            # Service Worker quản lý kết nối WebSocket bền vững
│   ├── content.js               # Bóc tách CC Meet, observer, Shadow DOM overlay
│   ├── overlay.css              # Style Glassmorphism cách ly trong Shadow DOM
│   ├── popup\                   # Giao diện menu bật/tắt & tùy chỉnh
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   └── icons\                   # Icon chuẩn kích thước 16, 48, 128px
│
└── translation_service\         # Dịch vụ suy luận dịch thuật Python
    ├── main.py                  # FastAPI server + WebSocket endpoint ws://127.0.0.1:8765/ws
    ├── translator.py            # Engine CTranslate2 tự động nhận diện CUDA RTX 4060 / CPU
    ├── cache_manager.py         # Bộ nhớ đệm LRU Cache lưu bền vững vào JSON
    ├── sequence_buffer.py       # Hàng đợi đảm bảo thứ tự câu dịch theo seq
    ├── setup_and_download.py    # Script tự động cài đặt và tải mô hình NLLB-200 CTranslate2
    ├── setup_env.bat            # File batch 1-click cài đặt môi trường
    ├── run_service.bat          # File batch 1-click khởi động dịch vụ
    ├── test_service.py          # Bộ kiểm thử đơn vị tự động đạt 100%
    ├── simulate_meet_stream.py  # Script mô phỏng dữ liệu Meet thực tế
    ├── requirements.txt         # Khóa cứng các phiên bản thư viện
    ├── models\                  # Thư mục lưu trọng số model CTranslate2 offline
    └── cache\                   # Thư mục lưu bộ đệm translations.json
```

---

## 🚀 Hướng Dẫn Sử Dụng Nhanh

### Bước 1: Cài đặt và Tải Mô Hình Dịch
1. Mở thư mục `translation_service`.
2. Nhấp đúp vào file **`setup_env.bat`** (hoặc mở terminal chạy `python setup_and_download.py`).
3. Script sẽ tự động:
   - Kiểm tra GPU NVIDIA RTX 4060 & CUDA.
   - Cài đặt đầy đủ các thư viện trong `requirements.txt`.
   - Tải mô hình NLLB-200 định dạng CTranslate2 về thư mục `models/nllb-200-600M-ct2`.

### Bước 2: Khởi động Dịch Vụ Dịch
1. Nhấp đúp vào file **`run_service.bat`** (hoặc chạy `python main.py`).
2. Màn hình console sẽ báo:
   ```
   ✅ Sẵn sàng! Thiết bị: CUDA (float16) | Cache: ... mục
   Listening on ws://127.0.0.1:8765/ws
   ```

### Bước 3: Nạp Extension vào Google Chrome
1. Mở trình duyệt Google Chrome, gõ vào thanh địa chỉ:
   ```
   chrome://extensions/
   ```
2. Bật công tắc **Developer mode** (Chế độ cho nhà phát triển) ở góc trên bên phải.
3. Nhấp vào nút **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục `d:\13-trans\extension`.

### Bước 4: Trải nghiệm trong Google Meet
1. Tham gia bất kỳ cuộc họp Google Meet nào.
2. Bật tính năng **Phụ đề (CC)** và chọn ngôn ngữ nói là **Tiếng Nhật (Japanese)**.
3. Khung phụ đề tiếng Việt mượt mà sẽ tự động xuất hiện ở góc dưới màn hình.
4. Bạn có thể kéo thả thanh tiêu đề để di chuyển vị trí khung dịch tới vị trí mong muốn; vị trí này sẽ được tự động lưu lại cho các lần họp sau.
