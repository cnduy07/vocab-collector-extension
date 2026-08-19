# Ghi chú nâng cấp — v0.1.0 → v0.2.0

*[English version](UPGRADE-NOTES.md)*

Tài liệu này giải thích: điều gì chưa tốt, những gì đã thay đổi, và mọi lỗi tìm
được trong quá trình làm, kèm lý do đằng sau từng cách sửa.

Có hai loại vấn đề được mô tả dưới đây, và chúng được tách riêng một cách có chủ ý:

- **Phần 1** là khiếm khuyết dẫn tới đợt nâng cấp này: chất lượng dịch.
- **Phần 2** liệt kê các lỗi tìm thấy *trong lúc viết và kiểm thử mã mới*.
  Lỗi 2.1 là lỗi thật, suýt nữa đã lọt vào bản phát hành. Các lỗi 2.2–2.5 được
  bắt trước khi phát hành; chúng nằm trong mã viết ở đợt nâng cấp này, không
  phải trong v0.1.0.

---

## 1. Vấn đề được báo: bản dịch chưa đủ tốt để đọc tài liệu kỹ thuật

### Điều gì chưa tốt

v0.1.0 dịch bằng **MyMemory**, một dịch vụ bộ nhớ dịch (translation memory). Nó
miễn phí và không cần khoá API, nhưng yếu với tiếng Anh kỹ thuật. Khi đọc tài
liệu phần mềm, nghĩa nó trả về thường bị dịch theo nghĩa đen và sai:

| từ trong tài liệu kỹ thuật | MyMemory dịch | nghĩa thật sự |
|---|---|---|
| commit | cam kết | bản ghi thay đổi trong Git |
| thread | sợi chỉ | luồng thực thi |
| socket | ổ cắm | đầu nối mạng |
| deprecated | phản đối | không còn được khuyến nghị dùng |
| race condition | điều kiện chủng tộc | lỗi tranh chấp thứ tự thực thi |

### Nguyên nhân gốc

Có hai nguyên nhân tách biệt, và đó cũng là lý do cách sửa gồm hai phần riêng.

1. **Máy dịch đang dùng là loại yếu nhất trong số có sẵn.** v0.1.0 chỉ dùng DeepL
   nếu bạn tự cung cấp khoá API, còn lại luôn rơi về MyMemory. Phần lớn thời gian
   tiện ích chạy bằng phương án dự phòng.
2. **Không máy dịch tổng quát nào biết bạn đang đọc lĩnh vực gì.** Ngay cả một
   máy dịch mạnh cũng sẽ dịch một từ đứng một mình theo nghĩa đời thường phổ biến
   nhất của nó. `commit` trong câu về Git và `commit` trong câu về pháp luật là
   hai từ khác nhau, và máy dịch chỉ nhận đúng một từ, không có ngữ cảnh, thì
   không thể phân biệt được.

### Cách sửa, gồm ba lớp

**Lớp 1 — máy dịch tốt hơn hẳn, không cần cấu hình gì.**

Việc tra nghĩa giờ đi qua endpoint web công khai của Google Translate:

```
https://translate.googleapis.com/translate_a/single
    ?client=gtx&sl=auto&tl=vi&hl=vi&dj=1&dt=t&dt=bd&q=<text>
```

Đây chính là máy dịch đứng sau translate.google.com, nên một từ sẽ trả về đúng
cách diễn đạt mà bạn nhận được nếu tự dán nó vào trang đó. Không cần khoá API.

Hai tham số đáng chú ý:

- `dj=1` yêu cầu JSON thường thay vì định dạng mảng theo vị trí của Google, nhờ
  vậy có thể phân tích phản hồi mà không phải đoán chỉ số mảng.
- `dt=bd` thêm **khối từ điển**: các nghĩa khác của từ, nhóm theo từ loại. Đây là
  lý do thẻ tra cứu giờ hiển thị được dòng `danh từ: …  ·  động từ: …` ngay dưới
  nghĩa chính. Không máy dịch nào khác trong chuỗi trả về dữ liệu này.

Thứ tự máy dịch có thể chỉnh trong Cài đặt, và nếu một máy dịch lỗi thì tiện ích
chuyển sang máy kế tiếp thay vì trả về thẻ rỗng:

```
Từ điển IT → Google Translate → DeepL (nếu có khoá) → MyMemory
```

**Lớp 2 — từ điển chuyên ngành ghi đè lên máy dịch.**

`background/glossary.js` là tệp mới: 327 thuật ngữ về phần mềm, web, dữ liệu,
xử lý đồng thời và vận hành, với nghĩa tiếng Việt được viết tay. Khi trúng từ
điển, nghĩa đó thắng bản dịch máy và được gắn nhãn **IT** trên thẻ.

Các dạng biến đổi của từ cũng được nhận ra nhờ hàm `getWordFormCandidates()` có
sẵn, nên bôi đen `threads` vẫn tìm ra mục `thread`.

Với những từ mà nghĩa đời thường thực sự khác hẳn — `commit`, `thread`,
`socket`, `port`, `fork`, và 27 từ nữa, liệt kê trong `AMBIGUOUS_TECH_TERMS` —
nghĩa đời thường cũng được hiển thị, để thẻ không che giấu việc từ đó còn có một
đời sống khác ngoài phần mềm.

**Lớp 3 — cả câu, không chỉ một từ.**

Content script giờ tìm ra câu chứa phần bạn bôi đen và dịch luôn câu đó, hiển thị
ở dòng **In context** có thể thu gọn.

Hàm `getContextSentence()` đi ngược lên phần tử khối gần nhất (`p`, `li`, `td`,
`pre`, …), đọc nội dung văn bản của nó, rồi mở rộng từ chỗ bôi đen ra hai phía
tới dấu câu gần nhất. Hàm dừng lại nếu khối đó dài hơn 1500 ký tự, để một trang
web nhét cả bài viết vào một thẻ `<div>` cũng không thể khiến thẻ tra cứu gửi cả
"bức tường chữ" đi dịch.

Đây chính là lớp giải quyết được sự nhập nhằng mà từ điển không xử lý nổi: nó cho
thấy từ đang được dùng như thế nào *trong đúng tài liệu bạn đang đọc*.

### Kết quả

Đo bằng API thật, bôi đen một từ nằm trong câu thật:

```
thread   → IT  luồng (đơn vị thực thi); chuỗi thảo luận
             danh từ: chỉ, dây nhỏ, đường chỉ may · động từ: xỏ kim
             In context: "Each request runs on its own thread in the worker pool."
                      → "Mỗi yêu cầu chạy trên luồng riêng của nó trong nhóm công nhân."

commit   → IT  commit — bản ghi thay đổi trong Git
             động từ: giao thác, hứa, ký thác, phạm
             /kəˈmɪt/
```

---

## 2. Các lỗi

### 2.1 Nút loa không bao giờ phát được âm thanh thật  ← suýt lọt vào bản phát hành

**Triệu chứng.** Nút loa vẫn kêu, nhưng luôn rơi xuống tầng cuối cùng là bộ đọc
giọng nói có sẵn của trình duyệt. Cả bản ghi âm từ từ điển lẫn Google
text-to-speech đều không bao giờ phát được.

**Quá trình tìm nguyên nhân.** Ba phép thử, và chỉ khi đặt cạnh nhau chúng mới có
ý nghĩa:

| phép thử | kết quả |
|---|---|
| `curl` vào URL Google TTS | `200`, `content-type: audio/mpeg`, 11328 byte |
| `new Audio(url)` trong trang web | `MEDIA_ELEMENT_ERROR: Format error` (MediaError mã 4) |
| `fetch(url)` trong trang web | ném lỗi `Failed to fetch` |

**Nguyên nhân gốc.** Hai rào chắn độc lập, và phải gỡ cả hai.

1. **Google trả nội dung khác nhau cho yêu cầu phát media của trình duyệt.** URL
   đó trả về file mp3 thật cho một HTTP client thường, nhưng phần tử `<audio>`
   lại nhận về thứ không giải mã được thành âm thanh. Lưu ý đây *không* phải lỗi
   CORS — phần tử media không thực hiện kiểm tra CORS. Đơn giản là dữ liệu nhận
   được không phải âm thanh, nên lỗi báo về là lỗi giải mã chứ không phải lỗi bảo
   mật.
2. **Một trang web hoàn toàn không thể fetch URL đó.** Phản hồi không có header
   `Access-Control-Allow-Origin`, nên trình duyệt chặn `fetch` khác nguồn gốc từ
   ngữ cảnh trang. Content script dùng chung ngữ cảnh này nên cũng bị chặn.

**Vì sao tiện ích lại làm được tốt hơn.** `manifest.json` khai báo:

```json
"host_permissions": ["https://translate.google.com/*", "https://api.dictionaryapi.dev/*", …]
```

Lệnh `fetch` phát đi **từ service worker** được miễn kiểm tra CORS với các host
nằm trong danh sách này. Nhờ vậy service worker lấy được file mp3 đúng theo cách
mà `curl` lấy. Không ngữ cảnh nào khác trong tiện ích làm được điều đó.

**Cách sửa.** Toàn bộ việc tải âm thanh được chuyển vào service worker. Hàm
`speak()` trong `background/background.js` giờ:

1. thử bản ghi âm của từ điển trước, rồi tới URL Google TTS;
2. loại bỏ mọi phản hồi có `content-type` không bắt đầu bằng `audio/` — nhờ vậy
   một máy chủ trả về trang HTML báo lỗi sẽ thất bại ngay với thông báo rõ ràng,
   thay vì gây ra lỗi giải mã khó hiểu ở bước sau;
3. loại bỏ phản hồi rỗng và mọi thứ lớn hơn 2 MB;
4. mã hoá base64 phần dữ liệu thành `data:` URL rồi gửi cho offscreen document.

Offscreen document giờ chỉ là một trình phát "ngốc": nó nhận âm thanh đã tải sẵn
và không bao giờ tự phát yêu cầu mạng, nên cả CORS lẫn Content-Security-Policy
của trang chủ nhà đều không thể can thiệp. Nếu không tải được gì, hoặc dữ liệu
không giải mã được, nó đọc từ đó bằng `speechSynthesis`.

**Tại sao lại cần offscreen document?** Service worker trong Manifest V3 không có
DOM nên không có phần tử `<audio>`. Content script thì có, nhưng media do nó tải
lại chịu sự quản lý của Content-Security-Policy của *trang chủ nhà*, nên nút loa
sẽ chết trên mọi trang có `media-src` nghiêm ngặt. Offscreen document chạy trên
chính nguồn gốc (origin) của tiện ích nên không dính cả hai ràng buộc. Nó cần
quyền `"offscreen"`, quyền này đã được thêm vào manifest.

**Kiểm chứng.** Chạy mã thật trên trình duyệt thật:

| trường hợp | kết quả |
|---|---|
| mp3 thật, tải về rồi nhúng thành `data:` URL | `<audio>` đạt trạng thái `playing` |
| URL trả về HTML thay vì âm thanh | bị chặn bởi kiểm tra content-type → chuyển sang đọc giọng nói |
| không có URL âm thanh nào | đọc giọng nói |

---

### 2.2 Các nghĩa tiếng Việt trả về ở dạng dấu tách rời

**Triệu chứng.** Dòng liệt kê các nghĩa lấy từ khối từ điển của Google lẽ ra sẽ
hiển thị dấu thanh khác hẳn so với dòng nghĩa chính ngay phía trên, và những
nghĩa trùng nhau sẽ bị liệt kê hai lần.

**Nguyên nhân gốc.** Google trả hai phần của cùng một phản hồi ở **hai dạng chuẩn
hoá Unicode khác nhau**:

| trường dữ liệu | dạng | `sự chấp nhận` chiếm… |
|---|---|---|
| `sentences[].trans` (bản dịch chính) | NFC — dạng dựng sẵn | 12 đơn vị mã |
| `dict[].terms` (các nghĩa khác) | NFD — dạng tách rời | 15 đơn vị mã |

Ở dạng NFD, `ự` được lưu thành `ư` (U+01B0) rồi tới dấu chấm dưới tổ hợp
(U+0323). Nhìn thì thường *gần* đúng, nhưng phông chữ dựng nó theo cách khác với
ký tự dựng sẵn, nên hai dòng trên thẻ không khớp nhau.

Hậu quả thứ hai còn tệ hơn vì nó vô hình: mã nguồn loại bỏ một nghĩa trùng với
nghĩa chính bằng cách so sánh hai chuỗi. `"sự cho phép"` dạng NFC và
`"sự cho phép"` dạng NFD **không bằng nhau** trong JavaScript, nên bản trùng lọt
qua bộ lọc và thẻ liệt kê cùng một nghĩa hai lần.

**Cách sửa.** Thêm hàm `toNfc()`, áp dụng cho bản dịch chính, cho từng nghĩa
trong danh sách, cho từng nhãn từ loại, và áp dụng bên trong `normalizeText()` —
hàm được dùng cho *mọi* phép so sánh chuỗi trong tiện ích, kể cả phép kiểm tra
"từ này đã lưu chưa". Chuẩn hoá ngay tại ranh giới dữ liệu vào nghĩa là phần mã
còn lại không bao giờ phải bận tâm tới chuyện này nữa.

---

### 2.3 Dòng "nghĩa thường" nhiều khi chỉ là nhiễu

**Triệu chứng.** Với từ `commit`, thẻ hiển thị `Nghĩa thường: làm` ngay dưới
nghĩa kỹ thuật. Dòng đó vô dụng.

**Nguyên nhân gốc.** Với các thuật ngữ kỹ thuật đa nghĩa, thẻ hiển thị bản dịch
máy của **từ đứng trần**. Một động từ dịch mà không có ngữ cảnh xung quanh sẽ rơi
vào một nghĩa mặc định chung chung; `commit` đứng một mình thành `làm`. Trong khi
đó, danh sách nghĩa theo từ loại nằm ngay bên dưới đã mang sẵn các nghĩa đời
thường thật sự — `giao thác, hứa, ký thác, phạm`.

Tức là thẻ đang tốn một dòng và tốn chiều cao để hiển thị phiên bản tệ nhất của
chính thông tin mà nó đã trình bày tốt hơn ở dòng kế tiếp.

**Cách sửa.** Dòng nghĩa đời thường giờ chỉ hiện khi **không có** danh sách nghĩa
theo từ loại để chuyển tải thông tin đó. Khi Google trả về danh sách nghĩa, danh
sách đó tốt hơn hẳn, và thẻ cũng ngắn hơn.

---

### 2.4 Phần ví dụ dù rỗng vẫn chiếm chỗ

**Triệu chứng.** Có vài pixel khoảng trống thừa trên thẻ trước khi tra cứu xong.

**Nguyên nhân gốc.** Lỗi thứ tự trong CSS. Phần tử ví dụ được đặt `display: none`
trong một quy tắc gộp, rồi một quy tắc sau đó lại đặt `display: -webkit-box` để
bật tính năng cắt gọn hai dòng:

```css
.vc-senses, .vc-general, .vc-example { display: none; }
.vc-example { display: -webkit-box; -webkit-line-clamp: 2; }   /* thắng */
```

Hai bộ chọn có cùng độ ưu tiên, nên quy tắc đứng sau thắng và phần tử thực chất
chưa bao giờ bị CSS ẩn đi. Nó chỉ *trông như* đã ẩn vì JavaScript gán
`display: none` nội tuyến sau mỗi lần tra cứu — điều không xảy ra trước khi lần
tra cứu đầu tiên trả về.

**Cách sửa.** Bỏ thuộc tính `display` khỏi quy tắc thứ hai. Hàm `setLine()` chỉ
gán `-webkit-box` khi thật sự có nội dung ví dụ, nên tính năng cắt gọn vẫn chạy
còn phần tử rỗng thì không chiếm chỗ nào.

---

### 2.5 Ba mục từ điển không bao giờ có thể được tra tới

**Triệu chứng.** Không thấy gì cả — đây là mã chết.

**Nguyên nhân gốc.** Ba khoá được viết kèm phần chú thích trong ngoặc:
`"scope (oauth)"`, `"instance (server)"`, `"throughput (ops)"`. Khoá tra cứu được
so khớp với đoạn văn bản người dùng bôi đen trên trang, mà không ai đi bôi đen
`scope (oauth)` cả. Cả ba mục này không che khuất mục nào và cũng không khớp với
gì.

**Cách sửa.** Đã xoá; các mục `scope`, `instance`, `throughput` dạng thường vốn
đã tồn tại sẵn. Sau đó tệp được kiểm tra thêm hai loại lỗi nữa:

- **khoá trùng lặp** — trong một object literal của JavaScript, khoá lặp lại chỉ
  giữ giá trị cuối cùng, nên một khoá bị gõ trùng do nhầm sẽ âm thầm ghi đè lên
  mục trước đó mà không có cảnh báo nào. Không tìm thấy trường hợp nào.
- **khoá sai định dạng** — bất kỳ khoá nào có chữ hoa, khoảng trắng thừa, hay dấu
  câu khiến nó không bao giờ khớp được với một đoạn bôi đen đã chuẩn hoá. Không
  còn khoá nào như vậy.

Còn lại 327 mục, tất cả đều ở dạng tra cứu hợp lệ.

---

### 2.6 Không phải lỗi: nhấp chuột vào bên trong thẻ

Ghi lại vì trong lúc kiểm thử nó trông hệt như một lỗi.

Kịch bản kiểm thử tự động đầu tiên nhấp đúp vào một từ ở đoạn văn thứ ba trong
khi thẻ của từ trước đó vẫn đang mở và che lên đoạn này. Cú nhấp rơi trúng thẻ,
và kịch bản báo rằng nó đã bôi đen từ tiếng Việt `bản` — lấy từ chính nội dung
của thẻ — và thẻ không cập nhật gì.

Đó là hành vi **đúng**. Hàm `isInsideOurUi()` kiểm tra `composedPath()` của sự
kiện và bỏ qua các thao tác bôi đen thực hiện bên trong giao diện của chính tiện
ích; nếu không, mỗi lần bạn thử bôi đen chữ trong thẻ, thẻ lại đi tra cứu chính
bản dịch của nó. Kịch bản kiểm thử đã được sửa để đóng thẻ trước. Tiện ích không
phải sửa gì.

---

## 3. Thay đổi giao diện

- Thẻ rộng **252 px** thay vì 280 px, khoảng đệm và cỡ chữ gọn hơn. Nó chứa nhiều
  thông tin hơn — các nghĩa khác, ngữ cảnh, nút loa — trong chiều cao ít hơn so
  với v0.1.0 vốn hiển thị ít nội dung hơn.
- **Chế độ tối**, theo `prefers-color-scheme`. Toàn bộ màu là biến CSS, khai báo
  một lần và định nghĩa lại trong khối tối.
- Thay các nút emoji (📘 📖) bằng biểu tượng SVG nội tuyến, vốn hiển thị giống
  nhau trên mọi nền tảng; emoji thì không.
- Thêm **nút loa** trên thẻ, và một nút nữa cạnh mỗi từ đã lưu trong popup thanh
  công cụ.
- Phím `Escape` đóng thẻ.
- Ví dụ bị cắt gọn còn hai dòng, và phần dịch cả câu mặc định thu gọn, nên một ví
  dụ hay một câu quá dài cũng không thể làm thẻ phình ra vô hạn.

---

## 4. Cách kiểm thử

Ba mức, vì mỗi mức bắt được những thứ mà hai mức kia không bắt được.

**Gọi thẳng API thật.** Endpoint Google Translate, Google TTS và Free Dictionary
API đều được gọi trực tiếp để xác nhận hình dạng phản hồi thật của chúng, thay vì
đoán. Lỗi chuẩn hoá Unicode (2.2) được tìm ra chính từ đây.

**Chạy service worker từ đầu tới cuối.** Nạp `background.js` trong Node với một
bản `chrome` API giả lập, rồi bắn vào đó các thông điệp thật để gọi API thật.
Cách này chạy trọn bộ luồng tra cứu — từ điển, chuỗi máy dịch dự phòng, dữ liệu
từ điển tiếng Anh, ngữ cảnh — cho tám thuật ngữ.

**Chạy đúng mã của tiện ích trên trình duyệt thật.** Chrome 151 đã gỡ bỏ tham số
dòng lệnh `--load-extension`, nên không còn cách nào tự động cài tiện ích vào một
trình duyệt tạm nữa. Thay vào đó, các tệp `content.js`, `background.js` và
`offscreen.js` thật được nạp nguyên vẹn vào một trang web kèm lớp giả lập
`chrome.*`, rồi điều khiển qua Chrome DevTools Protocol bằng thao tác nhấp đúp và
bấm nút thật. Nhờ đó kiểm tra được:

- bôi đen → thẻ hiện ra, neo đúng vị trí đoạn bôi đen
- tra cứu trực tiếp hiển thị đúng, gồm cả các nghĩa khác và ngữ cảnh câu
- nút loa và từng tầng trong chuỗi dự phòng của nó
- nút Lưu ghi đầy đủ bản ghi vào bộ nhớ
- lưu cùng một từ hai lần thì bị từ chối, số lượng trong bộ nhớ vẫn là 1
- nhấp vào bên trong thẻ thì bị bỏ qua
- không có lỗi JavaScript nào trên trang

**Phần chưa kiểm thử được.** Lớp đóng gói của Manifest V3 — việc đăng ký service
worker, việc tạo offscreen document thật, và việc chèn content script theo
manifest — chỉ tồn tại khi tiện ích được cài thật. Hãy nạp tiện ích và thử vài từ
để xác nhận nốt lớp này.

---

## 5. Giới hạn đã biết

- Endpoint công khai của Google Translate không có tài liệu chính thức và không
  đánh phiên bản. Nó đã ổn định nhiều năm và là thứ các tiện ích dịch trên trình
  duyệt vẫn dùng, nhưng Google có thể đổi hoặc giới hạn tần suất gọi. Đó đúng là
  lý do các phương án dự phòng DeepL và MyMemory được giữ lại chứ không xoá đi.
- Máy chủ âm thanh của Free Dictionary đang trả về `502` với mọi từ tại thời điểm
  viết tài liệu này, nên bản ghi âm giọng người tạm thời không dùng được và tầng
  Google text-to-speech đang gánh phần việc đó. Nút loa vẫn hoạt động bình
  thường.
- Từ điển IT được viết tay, nên nó chỉ bao phủ những từ nó có. Thêm một thuật ngữ
  chỉ tốn một dòng trong `background/glossary.js`.
