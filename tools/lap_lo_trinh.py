"""Dựng dữ liệu "Lộ trình chuẩn" cho tab Học → backend/app/lotrinh/<môn>.json.gz

Nguồn (tải về thư mục <nguồn> trước khi chạy, không đưa vào repo):
  git clone --depth 1 https://github.com/openlanguageprofiles/olp-en-cefrj      (CEFR-J 1.5 + Octanove C1/C2, CC BY-SA 4.0)
  git clone --depth 1 https://github.com/jamsinclair/open-anki-jlpt-decks       (JLPT N5–N1 theo tanos.co.uk, CC BY / MIT)
  git clone --depth 1 https://github.com/drkameleon/complete-hsk-vocabulary     (HSK 3.0 cấp 1–9, MIT)
  Tiếng Hàn: danh sách TOPIK I cơ bản soạn sẵn ở cuối file này (nghĩa tiếng Việt).
Thứ tự từ trong mỗi cấp: từ hay gặp trước (tần suất của thư viện wordfreq; HSK dùng tần suất có sẵn trong dữ liệu).

Chạy: python tools/lap_lo_trinh.py <nguồn>   (cần: pip install wordfreq)
"""
from __future__ import annotations

import csv
import gzip
import json
import sys
from pathlib import Path

from wordfreq import get_frequency_dict

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "backend" / "app" / "lotrinh"

POS_VI = {"noun": "danh từ", "verb": "động từ", "adjective": "tính từ", "adverb": "trạng từ", "preposition": "giới từ",
          "conjunction": "liên từ", "pronoun": "đại từ", "determiner": "hạn định từ", "number": "số từ",
          "interjection": "thán từ", "modal auxiliary": "động từ khuyết thiếu", "be-verb": "động từ to be",
          "do-verb": "trợ động từ", "have-verb": "trợ động từ", "infinitive-to": "", "auxiliary verb": "trợ động từ"}


def save(subject: str, data: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    p = OUT / f"{subject}.json.gz"
    p.write_bytes(gzip.compress(raw, 9, mtime=0))
    n = sum(len(lv["words"]) for lv in data["levels"])
    print(f"{p.relative_to(ROOT)}: {n} từ, {p.stat().st_size // 1024} KB")


def by_freq(words: list[list], lang: str, key=lambda w: w[0]) -> list[list]:
    f = get_frequency_dict(lang)
    return [w for _, w in sorted(enumerate(words), key=lambda x: (-f.get(key(x[1]).lower(), 0), x[0]))]


# ------------------------------------------------------------------ IELTS: CEFR A1 → C2
def ielts(src: Path) -> None:
    levels: dict[str, dict] = {}
    files = [("olp-en-cefrj/cefrj-vocabulary-profile-1.5.csv", "CEFR-J"), ("olp-en-cefrj/octanove-vocabulary-profile-c1c2-1.0.csv", "Octanove")]
    for name, _ in files:
        for r in csv.DictReader(open(src / name, encoding="utf-8")):
            lv = r["CEFR"].strip().upper()
            head = r["headword"].split("/")[0].strip()
            if not head or not lv:
                continue
            pos = POS_VI.get(r["pos"].strip().lower(), r["pos"].strip())
            words = levels.setdefault(lv, {})
            if head in words:
                if pos and pos not in words[head][4]:
                    words[head][4] += ", " + pos
            else:
                words[head] = [head, "", "", "", pos]
    seen: set[str] = set()
    names = {"A1": ("A1 – Nền tảng", "band 2.5–3.5"), "A2": ("A2 – Sơ cấp", "band 3.5–4.0"),
             "B1": ("B1 – Trung cấp", "band 4.0–5.0"), "B2": ("B2 – Trung cao cấp", "band 5.5–6.5"),
             "C1": ("C1 – Cao cấp", "band 7.0–8.0"), "C2": ("C2 – Thành thạo", "band 8.5–9.0")}
    out = []
    for lv in ("A1", "A2", "B1", "B2", "C1", "C2"):
        ws = [w for w in levels.get(lv, {}).values() if w[0].lower() not in seen]
        seen.update(w[0].lower() for w in ws)
        out.append({"id": lv, "name": names[lv][0], "target": names[lv][1], "words": by_freq(ws, "en")})
    save("ielts", {"name": "Từ vựng IELTS theo khung CEFR", "short": "CEFR A1 → C2",
                   "about": "Khung tham chiếu châu Âu (CEFR) – cách Cambridge/British Council quy đổi band IELTS. "
                            "A1–B2 theo CEFR-J Wordlist 1.5, C1–C2 theo Octanove Vocabulary Profile.",
                   "credit": "CEFR-J Wordlist Version 1.5, Yukio Tono, Tokyo University of Foreign Studies; Octanove Vocabulary "
                             "Profile C1/C2 ver 1.0, Octanove Labs (CC BY-SA 4.0).",
                   "lang": "en", "levels": out})


# ------------------------------------------------------------------ JLPT N5 → N1
def jlpt(src: Path) -> None:
    out, seen = [], set()
    names = {5: "Sơ cấp – khoảng 800 từ", 4: "Sơ trung cấp", 3: "Trung cấp", 2: "Trung cao cấp", 1: "Cao cấp"}
    for n in (5, 4, 3, 2, 1):
        ws = []
        for r in csv.DictReader(open(src / f"open-anki-jlpt-decks/src/n{n}.csv", encoding="utf-8")):
            front, reading = r["expression"].strip(), r["reading"].strip()
            if not front or front in seen:
                continue
            seen.add(front)
            ws.append([front, reading if reading != front else "", r["meaning"].strip(), "", ""])
        out.append({"id": f"N{n}", "name": f"JLPT N{n}", "target": names[n], "words": by_freq(ws, "ja")})
    save("ja", {"name": "Từ vựng JLPT", "short": "JLPT N5 → N1",
                "about": "Danh sách từ vựng theo 5 cấp kỳ thi năng lực tiếng Nhật JLPT (tổng hợp của tanos.co.uk, bản sửa của "
                         "Open Anki JLPT Decks). Nghĩa gốc tiếng Anh, app tự dịch sang tiếng Việt khi học.",
                "credit": "Jonathan Waller – tanos.co.uk (CC BY); Open Anki JLPT Decks – Jamie Sinclair (MIT).",
                "lang": "ja", "levels": out})


# ------------------------------------------------------------------ HSK 3.0 cấp 1 → 7-9
def hsk(src: Path) -> None:
    data = json.load(open(src / "complete-hsk-vocabulary/complete.min.json", encoding="utf-8"))
    lv: dict[int, list] = {}
    for w in data:
        news = [int(x[1:]) for x in w.get("l", []) if x.startswith("n")]
        if not news:
            continue
        forms = w.get("f") or [{}]
        ok = [x for x in forms if not any("variant of" in m for m in x.get("m") or [])] or forms
        f = next((x for x in ok if not (x.get("i") or {}).get("y", "a")[:1].isupper()), ok[0])
        mean = "; ".join(m if len(m) <= 70 else m[:67] + "…" for m in [m for m in f.get("m") or [] if "variant of" not in m][:3])
        lv.setdefault(min(news), []).append((w.get("q") or 10**9, [w["s"], (f.get("i") or {}).get("y", ""), mean, "",
                                                                  "phồn thể " + f["t"] if f.get("t") and f.get("t") != w["s"] else ""]))
    out = []
    for n in sorted(lv):
        ws = [x[1] for x in sorted(lv[n], key=lambda x: x[0])]
        out.append({"id": f"HSK{n}" if n < 7 else "HSK7-9", "name": f"HSK {n}" if n < 7 else "HSK 7–9",
                    "target": "Cao cấp" if n >= 7 else ("Sơ cấp" if n <= 2 else "Trung cấp" if n <= 4 else "Trung cao cấp"), "words": ws})
    save("zh", {"name": "Từ vựng HSK 3.0", "short": "HSK 1 → 9",
                "about": "Danh sách từ vựng chuẩn HSK 3.0 (Tiêu chuẩn trình độ tiếng Trung quốc tế, 2021): 9 cấp, cấp 7–9 gộp chung. "
                         "Có pinyin; cột thêm là chữ phồn thể.",
                "credit": "Complete HSK Vocabulary – Yanis Zafirópulos (MIT).", "lang": "zh", "levels": out})


# ------------------------------------------------------------------ TOPIK I (soạn sẵn)
KO = {
    "TOPIK1": ("TOPIK I – Cấp 1", "Sơ cấp 1", """
사람 người|친구 bạn bè|가족 gia đình|아버지 bố|어머니 mẹ|형 anh trai (em trai gọi)|오빠 anh trai (em gái gọi)|누나 chị gái (em trai gọi)
언니 chị gái (em gái gọi)|동생 em|남편 chồng|아내 vợ|아이 đứa trẻ|학생 học sinh|선생님 giáo viên|의사 bác sĩ|회사원 nhân viên công ty
이름 tên|나이 tuổi|나라 đất nước|한국 Hàn Quốc|베트남 Việt Nam|한국어 tiếng Hàn|말 lời nói|집 nhà|학교 trường học|회사 công ty
병원 bệnh viện|은행 ngân hàng|시장 chợ|식당 quán ăn, nhà hàng|가게 cửa hàng|백화점 trung tâm thương mại|우체국 bưu điện
도서관 thư viện|공원 công viên|화장실 nhà vệ sinh|방 phòng|교실 lớp học|역 nhà ga|공항 sân bay|길 đường|밥 cơm|물 nước
커피 cà phê|차 trà; xe ô tô|우유 sữa|빵 bánh mì|고기 thịt|생선 cá (món ăn)|과일 trái cây|사과 quả táo|김치 kim chi|음식 đồ ăn
술 rượu|옷 quần áo|신발 giày dép|모자 mũ|가방 cặp, túi xách|책 sách|공책 vở|연필 bút chì|의자 ghế|책상 bàn học|컴퓨터 máy tính
전화 điện thoại|휴대폰 điện thoại di động|돈 tiền|시계 đồng hồ|사진 ảnh|영화 phim|음악 âm nhạc|노래 bài hát
운동 thể thao, tập thể dục|여행 du lịch|날씨 thời tiết|비 mưa|눈 mắt; tuyết|바람 gió|봄 mùa xuân|여름 mùa hè|가을 mùa thu
겨울 mùa đông|오늘 hôm nay|어제 hôm qua|내일 ngày mai|아침 buổi sáng; bữa sáng|점심 buổi trưa; bữa trưa|저녁 buổi tối; bữa tối
밤 đêm|시간 thời gian; giờ|지금 bây giờ|주말 cuối tuần|생일 sinh nhật|월요일 thứ Hai|화요일 thứ Ba|수요일 thứ Tư|목요일 thứ Năm
금요일 thứ Sáu|토요일 thứ Bảy|일요일 Chủ nhật|하나 một (số thuần Hàn)|둘 hai (thuần Hàn)|셋 ba (thuần Hàn)|넷 bốn (thuần Hàn)
다섯 năm (thuần Hàn)|여섯 sáu (thuần Hàn)|일곱 bảy (thuần Hàn)|여덟 tám (thuần Hàn)|아홉 chín (thuần Hàn)|열 mười (thuần Hàn); sốt
일 một (Hán Hàn); công việc; ngày|이 hai (Hán Hàn); này|삼 ba (Hán Hàn)|사 bốn (Hán Hàn)|오 năm (Hán Hàn)|육 sáu (Hán Hàn)
칠 bảy (Hán Hàn)|팔 tám (Hán Hàn)|구 chín (Hán Hàn)|십 mười (Hán Hàn)|백 trăm|천 nghìn|만 mười nghìn|머리 đầu; tóc|얼굴 khuôn mặt
코 mũi|입 miệng|귀 tai|손 tay|발 bàn chân|다리 chân; cây cầu|몸 cơ thể|위 trên|아래 dưới|앞 phía trước|뒤 phía sau|옆 bên cạnh
안 bên trong|밖 bên ngoài|여기 ở đây|거기 ở đó|저기 đằng kia|이것 cái này|그것 cái đó|저것 cái kia|무엇 cái gì|누구 ai
어디 ở đâu|언제 khi nào|왜 tại sao|어떻게 như thế nào|얼마 bao nhiêu (tiền)|몇 mấy|가다 đi|오다 đến|먹다 ăn|마시다 uống|자다 ngủ
일어나다 thức dậy|보다 xem, nhìn|듣다 nghe|말하다 nói|읽다 đọc|쓰다 viết; dùng; đắng|배우다 học|공부하다 học bài|가르치다 dạy
일하다 làm việc|만나다 gặp|사다 mua|팔다 bán|주다 cho, đưa|받다 nhận|좋아하다 thích|싫어하다 ghét|알다 biết|모르다 không biết
있다 có; ở|없다 không có|하다 làm|앉다 ngồi|서다 đứng|걷다 đi bộ|타다 đi (xe), cưỡi|놀다 chơi|쉬다 nghỉ ngơi|기다리다 chờ đợi
사랑하다 yêu|입다 mặc|씻다 rửa|만들다 làm ra, chế tạo|열다 mở|닫다 đóng|좋다 tốt|나쁘다 xấu, tệ|크다 to, lớn|작다 nhỏ
많다 nhiều|적다 ít|싸다 rẻ|비싸다 đắt|맛있다 ngon|맛없다 không ngon|덥다 nóng|춥다 lạnh|따뜻하다 ấm áp|시원하다 mát mẻ
바쁘다 bận|예쁘다 đẹp|재미있다 thú vị|어렵다 khó|쉽다 dễ|길다 dài|짧다 ngắn|높다 cao|낮다 thấp|멀다 xa|가깝다 gần
아프다 đau, ốm|피곤하다 mệt|행복하다 hạnh phúc|안녕하세요 xin chào|감사합니다 cảm ơn|죄송합니다 xin lỗi|네 vâng|아니요 không
아주 rất|정말 thật sự|같이 cùng nhau|다 tất cả|또 lại, nữa|잘 giỏi, tốt|빨리 nhanh|천천히 chậm rãi|자주 thường xuyên|항상 luôn luôn"""),
    "TOPIK2": ("TOPIK I – Cấp 2", "Sơ cấp 2", """
경찰 cảnh sát|간호사 y tá|요리사 đầu bếp|가수 ca sĩ|손님 khách|남자 nam, đàn ông|여자 nữ, phụ nữ|어른 người lớn|부모님 bố mẹ
할아버지 ông|할머니 bà|아들 con trai|딸 con gái|고향 quê hương|주소 địa chỉ|번호 số|이메일 email|편지 thư|선물 quà|약 thuốc
약국 hiệu thuốc|표 vé|지하철 tàu điện ngầm|버스 xe buýt|택시 taxi|기차 tàu hỏa|비행기 máy bay|자전거 xe đạp|자동차 ô tô
정류장 trạm xe buýt|교통 giao thông|신호등 đèn giao thông|횡단보도 vạch sang đường|오른쪽 bên phải|왼쪽 bên trái
근처 gần đây, lân cận|동네 khu phố|아파트 chung cư|부엌 nhà bếp|거실 phòng khách|냉장고 tủ lạnh|세탁기 máy giặt|창문 cửa sổ
문 cửa|계단 cầu thang|엘리베이터 thang máy|건물 tòa nhà|층 tầng|취미 sở thích|축구 bóng đá|수영 bơi lội|등산 leo núi|낚시 câu cá
요리 món ăn; nấu ăn|그림 bức tranh|게임 trò chơi|경기 trận đấu|계획 kế hoạch|약속 cuộc hẹn; lời hứa|회의 cuộc họp|수업 giờ học
숙제 bài tập về nhà|시험 kỳ thi|질문 câu hỏi|대답 câu trả lời|문제 vấn đề; câu hỏi (bài thi)|이유 lý do|경험 kinh nghiệm
문화 văn hóa|역사 lịch sử|뉴스 tin tức|신문 báo|인터넷 internet|값 giá|가격 giá cả|할인 giảm giá|카드 thẻ|현금 tiền mặt
거스름돈 tiền thừa|크기 kích cỡ|색깔 màu sắc|빨간색 màu đỏ|파란색 màu xanh dương|노란색 màu vàng|하얀색 màu trắng
검은색 màu đen|기분 tâm trạng|감기 cảm cúm|병 bệnh; cái chai|건강 sức khỏe|마음 tấm lòng, trái tim|생각 suy nghĩ|사랑 tình yêu
꿈 giấc mơ; ước mơ|휴가 kỳ nghỉ phép|방학 kỳ nghỉ (của trường)|하루 một ngày|일주일 một tuần|달 tháng; mặt trăng|년 năm
작년 năm ngoái|올해 năm nay|내년 năm sau|처음 lần đầu|마지막 cuối cùng|다음 tiếp theo|지난주 tuần trước|매일 mỗi ngày
시작하다 bắt đầu|끝나다 kết thúc|도착하다 đến nơi|출발하다 xuất phát|내리다 xuống (xe); rơi (mưa, tuyết)|갈아타다 chuyển (xe, tàu)
돌아가다 quay về|들어가다 đi vào|나가다 đi ra|올라가다 đi lên|내려가다 đi xuống|찾다 tìm|잃어버리다 đánh mất|빌리다 mượn
돕다 giúp đỡ|부탁하다 nhờ vả|준비하다 chuẩn bị|연습하다 luyện tập|운전하다 lái xe|청소하다 dọn dẹp|빨래하다 giặt giũ
요리하다 nấu ăn|결혼하다 kết hôn|이사하다 chuyển nhà|졸업하다 tốt nghiệp|입학하다 nhập học|전화하다 gọi điện thoại
이야기하다 trò chuyện|대답하다 trả lời|묻다 hỏi|생각하다 suy nghĩ|기억하다 nhớ|잊다 quên|느끼다 cảm thấy|웃다 cười|울다 khóc
걱정하다 lo lắng|다니다 đi lại (thường xuyên)|보내다 gửi|바꾸다 đổi|고르다 chọn|신다 đi (giày, tất)|벗다 cởi|켜다 bật|끄다 tắt
깨끗하다 sạch sẽ|더럽다 bẩn|조용하다 yên tĩnh|시끄럽다 ồn ào|편하다 tiện, thoải mái|불편하다 bất tiện|친절하다 tử tế, thân thiện
무섭다 đáng sợ|슬프다 buồn|기쁘다 vui|즐겁다 vui vẻ|반갑다 vui mừng (khi gặp)|귀엽다 dễ thương|멋있다 ngầu, đẹp|맵다 cay
달다 ngọt|짜다 mặn|배고프다 đói|배부르다 no|목마르다 khát|중요하다 quan trọng|필요하다 cần thiết|유명하다 nổi tiếng
같다 giống|다르다 khác|젊다 trẻ|늦다 muộn|빠르다 nhanh|느리다 chậm|먼저 trước tiên|나중에 sau này|벌써 đã ... rồi|아직 vẫn, chưa
조금 một chút|너무 quá|제일 nhất|더 hơn|혼자 một mình|함께 cùng nhau|꼭 nhất định|아마 có lẽ|그래서 vì vậy|그런데 nhưng mà
그리고 và|하지만 tuy nhiên"""),
}
_CHO = "g kk n d tt r m b pp s ss - j jj ch k t p h".split()
_JUNG = "a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i".split()
_JONG = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t",
         "k", "t", "p", "t"]
_JONG_LINK = ["", "g", "kk", "ks", "n", "nj", "nh", "d", "r", "lg", "lm", "lb", "ls", "lt", "lp", "lh", "m", "b", "bs", "s", "ss",
              "ng", "j", "ch", "k", "t", "p", "h"]


def romaja(word: str) -> str:
    """Phiên âm Latinh gần đúng (Romaja quốc ngữ, có nối âm khi âm sau bắt đầu bằng ㅇ)."""
    out = []
    syl = [ord(c) - 0xAC00 if 0xAC00 <= ord(c) <= 0xD7A3 else None for c in word]
    for i, s in enumerate(syl):
        if s is None:
            out.append(word[i])
            continue
        cho, jung, jong = s // 588, (s % 588) // 28, s % 28
        prev_link = i > 0 and syl[i - 1] is not None and syl[i - 1] % 28 and cho == 11 and syl[i - 1] % 28 != 21
        lead = "" if cho == 11 or prev_link else _CHO[cho]
        nxt = syl[i + 1] if i + 1 < len(syl) else None
        tail = _JONG_LINK[jong] if jong and nxt is not None and nxt // 588 == 11 and jong != 21 else _JONG[jong]
        out.append(lead + _JUNG[jung] + tail)
    return "".join(out)


def topik() -> None:
    out = []
    for lid, (name, target, text) in KO.items():
        ws = []
        for item in text.replace("\n", "|").split("|"):
            item = item.strip()
            if not item:
                continue
            front, vi = item.split(" ", 1)
            ws.append([front, romaja(front), "", vi.strip(), ""])
        out.append({"id": lid, "name": name, "target": target, "words": ws})
    save("ko", {"name": "Từ vựng TOPIK I", "short": "TOPIK I (cấp 1–2)",
                "about": "Từ vựng cơ bản nhất của TOPIK I theo chủ đề (người, nơi chốn, đồ vật, thời gian, số đếm, động từ, tính từ), "
                         "nghĩa tiếng Việt soạn sẵn. TOPIK II (cấp 3–6): nhập thêm bằng file JSON/CSV.",
                "credit": "CircleVault soạn.", "lang": "ko", "levels": out})


if __name__ == "__main__":
    src = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    ielts(src)
    jlpt(src)
    hsk(src)
    topik()
