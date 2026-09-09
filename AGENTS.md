# KANTANDA ENGINEERING BRAIN — AGENT OPERATING PROTOCOL

Thư viện quy chuẩn (`D:\10-kantanda\`) là chuẩn mực kỹ thuật cao nhất cho toàn bộ hệ thống phát triển phần mềm.
Mọi AI Coding Agent (Antigravity, Cursor, Claude Code) PHẢI tuân thủ vòng lặp 4 bước sau:

```
[User Task] ──> Bước 1: Routing (taxonomy.xml) ──> Bước 2: Load Rules (.rules.xml) ──> Bước 3: Coding (rule-priority.xml) ──> Bước 4: Self-Audit Gate
```

---

## 1. Bước 1: Task Routing & Phân Loại
Khi nhận prompt từ người dùng, Agent tra cứu `taxonomy.xml` và `index.xml`:
- Xác định domain chính: `backend`, `frontend`, `common`, `design-system`, hoặc `workflows`.
- Xác định category: ví dụ `api`, `database`, `rag`, `security`, `ux-ui`.

## 2. Bước 2: Nạp đúng các file Atomic Rules liên quan
Agent chỉ đọc các file XML tương ứng, tuyệt đối **không duyệt toàn bộ kho tài liệu**:
- Ví dụ task backend API: Đọc `backend/api/validation.rules.xml`, `backend/api/response.rules.xml`, `backend/database/query.rules.xml`.
- Ví dụ task destructive modal: Đọc `frontend/ux-ui/dialog.rules.xml`, `design-system/components/dialog.rules.xml`.

## 3. Bước 3: Áp dụng thứ tự ưu tiên (rule-priority.xml)
Khi sinh mã nguồn, luôn tuân thủ ma trận ưu tiên:
1. **Rank 1 - Security & Privacy:** Anti-BOLA, Prompt Injection, Input Validation, Zero PII Logging.
2. **Rank 2 - Correctness & Typing:** Không dùng `any`, Discriminated Unions, Prisma Transactions.
3. **Rank 3 - Maintainability & Clean Code:** Hàm <= 40 dòng, SRP, Low Coupling, High Cohesion.
4. **Rank 4 - Performance:** Tối ưu hóa có đo lường, không tối ưu sớm.

## 4. Bước 4: Tự kiểm tra đối soát (Self-Audit Gate)
Trước khi trả mã nguồn cho lập trình viên, Agent tự rà soát theo checklist từ `workflows/code-review.xml`:
- [ ] Bảo mật: Mọi câu lệnh mutation đều có ràng buộc `tenantId` / `userId`?
- [ ] Tính toàn vẹn: Request qua Zod `.strict()`, Response chuẩn envelope `{ success, data, error, meta }`?
- [ ] Ranh giới: Không leak logic backend sang client component, có đủ 5 trạng thái UI?
