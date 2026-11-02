# Đố Vui LIVE

Trò đố vui tiếng Việt cho TikTok LIVE. Máy đọc câu hỏi, người xem gõ đáp án vào bình luận, ai đúng nhanh nhất được nhiều điểm. Tặng quà được nhân điểm. Có bảng vàng theo ngày.

## Chạy

Cần Node.js 20 trở lên.

```bash
cd do-vui
npm install
npm start          # http://localhost:3100
npm test           # kiểm tra phần chấm đáp án và chọn câu
```

1. Mở `http://localhost:3100` (bảng điều khiển).
2. Bấm **Mở màn hình overlay 9:16**, rồi bấm **Bật âm thanh** một lần trong cửa sổ đó.
3. TikTok LIVE Studio: *Window capture* cửa sổ overlay và thêm nguồn âm thanh của ứng dụng. OBS: *Browser source* `http://localhost:3100/overlay`, 1080×1920, tích *Control audio via OBS*.
4. Bật LIVE, nhập `@username`, bấm **Kết nối**, rồi bấm **Bắt đầu**.

Chưa live vẫn thử được bằng **Bot trả lời mô phỏng** và ô **Thử khi chưa live**.

**Server một máy, LIVE Studio máy khác** (vd. server trên Linux, LIVE Studio trên Windows cùng Wi-Fi): thêm `HOST=0.0.0.0` vào `.env` rồi chạy lại. Server ghi địa chỉ LAN vào nhật ký, dạng `http://192.168.x.x:3100/overlay`. Trên máy Windows mở link đó bằng Chrome/Edge, nhấn F11 cho toàn màn hình, bấm **Bật âm thanh**, rồi dùng *Window capture* trong LIVE Studio. Bảng điều khiển chỉ mở trên máy chạy server, máy khác chỉ xem được overlay. Nếu máy server có tường lửa thì mở cổng 3100.

## Câu hỏi lấy từ đâu

```
1. Google Sheet, theo thứ tự từ trên xuống; bỏ qua câu đã hỏi trong 2 giờ (chỉnh được)
2. Hết câu mới → Gemini tạo câu mới (tạo sẵn ở chế độ nền trước khi Sheet cạn)
3. Gemini tắt hoặc lỗi → hỏi lại Sheet từ đầu (câu hỏi lâu nhất trước)
```

Chưa đặt link Sheet thì dùng 52 câu trong `cau-hoi-mau.csv`. Có thể nhập thẳng file này vào Google Sheet để làm khung.

**Google Sheet:** dòng đầu là tiêu đề, có thể viết có dấu hoặc không dấu.

| Câu hỏi | Đáp án | Đáp án khác | Chủ đề | Độ khó | Gợi ý | Bật |
|---|---|---|---|---|---|---|
| Thành phố đông dân nhất Việt Nam? | Hồ Chí Minh | Sài Gòn\|TPHCM\|SG | Địa lý | 1 | | |

- Bắt buộc có cột *Câu hỏi* và *Đáp án*. Các đáp án khác ngăn cách bằng `|`.
- Không có *Gợi ý* thì máy tự tạo dạng `H _   C _ _   M _ _ _`.
- Cột *Bật* ghi `không` thì câu đó bị bỏ qua.
- Chia sẻ Sheet ở chế độ *Bất kỳ ai có đường liên kết → Người xem*, rồi dán link vào bảng điều khiển. Server tự tải lại mỗi 5 phút và giữ bản lưu khi mất mạng.

**Gemini:** chép `.env.example` thành `.env` rồi điền `GEMINI_API_KEY` (lấy miễn phí ở Google AI Studio). Mỗi lô 10 câu được Gemini tự kiểm tra lại một lần, và chỉ giữ câu có đáp án ngắn. Mọi câu Gemini tạo được lưu ở `data/gemini-cau-hoi.csv` để bạn chọn câu hay chép vào Sheet. AI vẫn có thể sai: câu do AI tạo có nhãn ✨ AI trên overlay.

## Luật chấm

- Không phân biệt hoa thường, có dấu hay không dấu: `Đà Nẵng` = `da nang` = `danang` = `là đà nẵng`.
- Đáp án dài từ 6 chữ cái trở lên được sai 1 ký tự. Số thì phải đúng tuyệt đối.
- Điểm: nhanh nhất 10, thứ hai 7, thứ ba 5, đúng sau đó 3. Sau người đúng đầu tiên còn 4 giây cho người khác.
- Mỗi người tối đa 6 lần đoán mỗi câu, để không ai dán cả danh sách đáp án.
- Tặng quà: điểm ×2 trong 10 phút (quà từ 99 kim cương thì ×3). Có thể tắt.

## Chế độ đội leo bậc

Chọn trên bảng điều khiển: **Chế độ chơi → Đội leo bậc**.

- 2 hoặc 3 đội (tên đặt được), mỗi đội tối đa 20 người (chỉnh được). **Vào đội phải xin:** gõ `tham gia` (vào đội ít người nhất) hoặc gõ tên đội / `1`, `2`, `3`. Đội còn chỗ thì vào lúc nào cũng được, kể cả giữa trận (bắt đầu từ bậc 0). Đội đủ người thì người xin vào được báo trên màn hình.
- **Sân đấu ở trên, khán đài ở dưới:** ai bình luận mà chưa vào đội thì ngồi ở khán đài (2 hàng ghế, phần còn lại gộp thành "+n"). **Chỉ câu trả lời của người trong đội mới được tính.** Khán giả gõ thứ trông giống đáp án thì được nhắc gõ "tham gia" (mỗi người tối đa 1 lần mỗi 2 phút, cả màn hình tối đa 1 lời nhắc mỗi 8 giây).
- **Phòng chờ:** bấm *Bắt đầu* thì mở phòng chờ. Khi mỗi đội có ít nhất 1 người thì đếm ngược (mặc định 15 giây) rồi vào câu đầu. Trước trận đổi đội thoải mái. Hết trận, nếu vẫn đủ người thì sang trận mới luôn sau giờ nghỉ.
- Mỗi trận dài 3–60 phút (mặc định 15), mỗi câu 15–120 giây (mặc định 30). Mỗi người trả lời 1 lần mỗi câu.
- **Chat:** `/chat đội bạn gà lắm` (hoặc `/c …`) hiện bong bóng trên avatar người gõ. Mỗi người cách nhau 15 giây, từ tục bị che `***`, link bị xóa, không đọc thành tiếng. Dùng được cả ở chế độ cá nhân. Tắt được trên bảng điều khiển.
- Đúng thì leo 1 bậc, sai thì tụt 1 bậc (có thể tắt). Mọi người cùng di chuyển lúc lật đáp án.
- Chuyện phiếm ("hay quá", "chào cả nhà", câu dài) không bị tính là trả lời sai.
- Trong trận, mỗi người đổi đội được 1 lần, và người đổi về lại bậc 0. Người cuối cùng của một đội không được bỏ đội.
- Đội xếp hạng theo **số bậc trung bình** của những người đã trả lời, nên đội đông không tự thắng. Hết giờ thì hiện đội thắng và người leo cao nhất, nghỉ rồi sang trận mới với đội giữ nguyên.
- Trong chế độ đội, quà chỉ có hiệu ứng, không tính bậc.

## Ảnh, nhạc, giao diện

Overlay tự vẽ bằng CSS nên không cần ảnh. Muốn thay thì bỏ file vào `assets/` (xem `assets/README.txt`): `bg.jpg` làm nền, `logo.png` làm logo, `host.png` làm nhân vật dẫn, `music/*.mp3` làm nhạc nền. Chỉ dùng nhạc bạn có quyền phát.

Nội dung quan trọng nằm trong vùng y 200–1250 của khung 1080×1920, vì giao diện TikTok che phần trên cùng và khoảng 650px phía dưới.

## Bảo mật

Giống bộ chánh điện: server mặc định chỉ nghe `127.0.0.1` (bật `HOST=0.0.0.0` thì máy khác trong LAN xem được overlay, nhưng bảng điều khiển vẫn chỉ mở được trên máy chạy server), kiểm tra `Host` và `Origin`, file tĩnh có danh sách trắng, overlay chỉ nhận dữ liệu. Key Gemini chỉ nằm trong `.env` trên máy, không bao giờ gửi xuống trình duyệt. Đáp án chỉ hiện trên bảng điều khiển, không hiện trên overlay trước khi hết giờ.

## Dữ liệu trên máy

`data/` (không đưa lên git): `settings.json` (cài đặt), `history.json` (câu đã hỏi, dùng cho luật 2 giờ), `scores.json` (bảng điểm hôm nay), `sheet-cache.csv`, `gemini-cau-hoi.csv`.
