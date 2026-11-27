from __future__ import annotations

import base64
import json
import os
import re
import struct
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

try:
    import frappe
except ImportError:
    frappe = None


def _get_key() -> str:
    k = (os.getenv("GOOGLE_API_KEY") or "").strip()
    if not k and frappe:
        try:
            k = (frappe.conf.get("google_api_key") or "").strip()
        except Exception:
            k = ""
    return "" if k in ("", "your_google_gemini_api_key_here") else k


def _extract_json(raw: str) -> Optional[Dict[str, Any]]:
    if not raw:
        return None
    text = raw.strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    else:
        m2 = re.search(r"(\{.*\})", text, re.DOTALL)
        if m2:
            text = m2.group(1)
    try:
        return json.loads(text)
    except Exception:
        return None


def _call_gemini(
    model: str,
    system_prompt: str,
    parts: List[Dict[str, Any]],
    json_mode: bool = True,
    temperature: float = 0.3,
) -> Tuple[Optional[Dict[str, Any]], int]:
    key = _get_key()
    if not key:
        return None, 0

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    gen_cfg: Dict[str, Any] = {"temperature": temperature}
    if json_mode:
        gen_cfg["responseMimeType"] = "application/json"

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": gen_cfg,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            tokens = int(body.get("usageMetadata", {}).get("totalTokenCount", 0))
            c_parts = body.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            txt = "".join(p.get("text", "") for p in c_parts)
            return (_extract_json(txt) if json_mode else {"text": txt}), tokens
    except Exception as e:
        if frappe:
            try:
                frappe.log_error(f"Gemini error ({model}): {e}", "elif_tutor.gemini")
            except Exception:
                pass
        return None, 0


WHITEBOARD_SCHEMA_GUIDE = """
Tahta ve çizim komutları (whiteboard JSON):
{
  "action": "append | replace | clear",
  "title": "Tahta Başlığı",
  "steps": ["Adım metinleri... (action='append' ise sadece yeni adım)"],
  "latex": "KaTeX matematik ifadesi",
  "drawing": {
    "type": "none | fraction_bar | geometry_triangle | geometry_rectangle | number_line | solar_system | electric_circuit | english_card | concept_map",
    "params": {}
  }
}
TAHTA KURALLARI:
- Yeni bir çözüm adımı eklendiğinde action='append' kullan ve sadece yeni adımı steps listesine koy (önceki adımlar ve çizim korunur).
- Yanlış bir adımı düzeltmek veya baştan çizmek için action='replace' kullan.
- Yeni bir soruya geçerken tahtayı temizlemek için action='clear' kullan.
"""


def apply_whiteboard_action(current_wb: Optional[Dict[str, Any]], incoming_wb: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    current_wb = dict(current_wb or {})
    if not incoming_wb or not isinstance(incoming_wb, dict):
        return current_wb

    action = (incoming_wb.get("action") or "replace").strip().lower()

    if action == "clear":
        return {
            "title": incoming_wb.get("title") or "Akıllı Ders Tahtası",
            "steps": incoming_wb.get("steps") or [],
            "latex": incoming_wb.get("latex") or "",
            "drawing": incoming_wb.get("drawing") or {"type": "none", "params": {}},
        }

    if action == "append":
        existing_steps = list(current_wb.get("steps") or [])
        new_steps = incoming_wb.get("steps") or []
        for s in new_steps:
            if s and s not in existing_steps:
                existing_steps.append(s)
        current_wb["steps"] = existing_steps
        if incoming_wb.get("title"):
            current_wb["title"] = incoming_wb["title"]
        if incoming_wb.get("latex"):
            current_wb["latex"] = incoming_wb["latex"]
        if incoming_wb.get("drawing") and incoming_wb["drawing"].get("type") != "none":
            current_wb["drawing"] = incoming_wb["drawing"]
        return current_wb

    # replace mode
    res = dict(incoming_wb)
    res.setdefault("title", current_wb.get("title") or "Akıllı Ders Tahtası")
    res.setdefault("steps", incoming_wb.get("steps") or current_wb.get("steps") or [])
    res.setdefault("latex", incoming_wb.get("latex") or "")
    res.setdefault("drawing", incoming_wb.get("drawing") or {"type": "none", "params": {}})
    return res


def _resolve_student_info(passed_name: str = "", passed_grade: str = "") -> Tuple[str, str]:
    name = (passed_name or "").strip()
    grade = (passed_grade or "").strip()

    if not name and frappe and getattr(frappe, "session", None) and frappe.session.user and frappe.session.user != "Guest":
        u = frappe.session.user
        try:
            fn = frappe.db.get_value("User", u, "first_name")
            full = frappe.db.get_value("User", u, "full_name")
            if fn and fn.strip() and fn.lower() not in ("administrator", "admin", "guest"):
                name = fn.strip()
            elif full and full.strip() and full.lower() not in ("administrator", "admin", "guest"):
                name = full.strip().split()[0]
        except Exception:
            pass

    if not name:
        n = (os.getenv("STUDENT_NAME") or "").strip()
        if n and n.lower() not in ("öğrenci", "ogrenci", "student"):
            name = n

    if not grade:
        grade = (os.getenv("STUDENT_GRADE") or "5. Sınıf").strip()

    if name.lower() in ("öğrenci", "ogrenci", "student", "null", "none"):
        name = ""

    return name, grade


def _student_name() -> str:
    n, _ = _resolve_student_info()
    return n


def _student_grade() -> str:
    _, g = _resolve_student_info()
    return g


def analyze_homework_page(
    file_bytes: bytes,
    mime_type: str,
    subject_hint: str,
    student_note: str = "",
    long_term_memory: Optional[List[Dict[str, Any]]] = None,
    student_name: str = "",
    student_grade: str = "",
) -> Tuple[Dict[str, Any], int]:
    """Ödev sayfasını tek seferlik görsel analiz ile okur, soruları ve kontrol durumunu çıkarır."""
    b64 = base64.b64encode(file_bytes).decode("ascii")
    sname, sgrade = _resolve_student_info(student_name, student_grade)

    if sname:
        addr_rule = f"Öğrencinin adı: {sname} ({sgrade}). Konuşmalarında ona sıcak bir abla/öğretmen samimiyetiyle ismiyle hitap et ('Hoş geldin {sname}!', 'Hadi gel birlikte bakalım')."
    else:
        addr_rule = f"Öğrencinin seviyesi: {sgrade}. Öğrenciye hitap ederken 'Öğrenci' kelimesini bir insan ismiymiş gibi ('Hoş geldin Öğrenci') KESİNLİKLE KULLANMA! Bunun yerine 'Hoş geldin sevgili öğrencim!', 'Hadi gel bakalım, ödevine başlayalım' gibi doğal ve sevecen hitaplar kullan."

    system_prompt = (
        f"Sen {sgrade} öğrencisi ile birebir ev ödevi çalışan sevecen, sabırlı ve neşeli bir Sanal Öğretmensin (Adın: Elif Öğretmen).\n"
        f"{addr_rule}\n"
        "ÖDEV KONTROL VE ANLATIM AKIŞI:\n"
        "1. Sayfadaki tüm soruları 'questions' dizisine çıkar ve kağıtta yazılı/işaretli cevap var mı kontrol et:\n"
        "   - Cevap yazılmış ve doğruysa -> paper_check='correct', student_written_answer='yazılı cevap'.\n"
        "   - Cevap yazılmış ve yanlışsa -> paper_check='wrong', student_written_answer='yazılı cevap', mistake_reason='neden yanlış olduğu ve nasıl düşünüleceği'.\n"
        "   - Boş / yapılmamışsa -> paper_check='blank', student_written_answer=''.\n"
        "2. Konuşma metni ('spoken_text') ve tahta ('whiteboard'):\n"
        "   - spoken_text en fazla 2-3 kısa, enerjik, samimi ve konuşma dilinde doğal Türkçe cümle olsun (TTS seslendirmesine uygun).\n"
        "   - Kağıtta yanlış varsa: önce doğruları tebrik et, sonra ilk yanlış soruda moral vererek nedenini açıkla ve birlikte ilk adıma davet et.\n"
        "   - Tüm sorular doğruysa: coşkuyla tebrik et (emotion='celebrate') ve ödevin başarıyla bittiğini bildir.\n"
        "   - Ödev boşsa: 1. soruyu tane tane oku, günlük dille ne istediğini açıkla, tahtaya Verilenler/İstenen koy ve ilk küçük adımı sor.\n"
        f"{WHITEBOARD_SCHEMA_GUIDE}\n"
        "SADECE şu JSON formatında yanıt ver:\n"
        '{"subject": "Matematik|Fen Bilimleri|Türkçe|İngilizce|Sosyal Bilgiler|Din Kültürü", "topic": "Konu adı", '
        '"questions": [{"no": 1, "text": "1. sorunun tam metni", "latex": "", "correct_solution_hidden": "kesin çözüm", '
        '"student_written_answer": "", "paper_check": "blank|correct|wrong", "mistake_reason": ""}], '
        '"spoken_text": "...", "emotion": "happy|thinking|celebrate|encouraging", "whiteboard": {...}}'
    )
    mem_line = (
        f"\nÖğrencinin Bu Dersteki Önceki Öğrenme Hafızası (ilgiliyse doğalca hatırla): {json.dumps(long_term_memory, ensure_ascii=False)}"
        if long_term_memory else ""
    )
    parts = [
        {"inline_data": {"mime_type": mime_type, "data": b64}},
        {"text": f"Öğrenci: {sname} | Ders: {subject_hint}\nNot: {student_note or 'Ödev kağıdını incele: cevaplıysa kontrol et, boşsa birlikte çözelim.'}{mem_line}"},
    ]
    model = (os.getenv("GEMINI_VISION_MODEL") or "gemini-3.5-flash-lite").strip()
    result, tokens = _call_gemini(model, system_prompt, parts, json_mode=True, temperature=0.2)
    if not result and model != "gemini-3.5-flash-lite":
        result, tokens = _call_gemini("gemini-3.5-flash-lite", system_prompt, parts, json_mode=True, temperature=0.2)
    if not result:
        return {
            "subject": subject_hint,
            "topic": "Ev Ödevi",
            "questions": [],
            "spoken_text": "Sayfa net okunamadı, ödev kağıdını daha düz ve aydınlık bir yerde tekrar yükler misin?",
            "emotion": "encouraging",
            "whiteboard": {"title": "Tekrar Deneyelim", "steps": ["Ödev sayfasını net şekilde yükle"], "latex": "", "drawing": {"type": "none", "params": {}}},
        }, tokens
    return result, tokens


def chat_socratic_turn(
    subject: str,
    active_question: Dict[str, Any],
    homework_memory: Dict[str, Any],
    recent_messages: List[Dict[str, Any]],
    student_text: str,
    long_term_memory: Optional[List[Dict[str, Any]]] = None,
    compaction_briefing: str = "",
    pedagogical_memory: Optional[Dict[str, Any]] = None,
    current_whiteboard: Optional[Dict[str, Any]] = None,
    teacher_name: str = "Elif Öğretmen",
    teacher_gender: str = "female",
    student_name: str = "",
    student_grade: str = "",
) -> Tuple[Dict[str, Any], int]:
    sname, sgrade = _resolve_student_info(student_name, student_grade)
    tname = teacher_name or "Elif Öğretmen"
    chat_history = "\n".join(f"{m.get('role')}: {m.get('text')}" for m in recent_messages[-4:])

    if sname:
        addr_rule = f"Öğrencinin adı: {sname} ({sgrade}). Ona ismiyle, sıcak ve motive edici bir öğretmen samimiyetiyle hitap et ('Harikasın {sname}!', 'Hadi {sname}, gel birlikte bakalım')."
    else:
        addr_rule = (
            f"Öğrencinin seviyesi: {sgrade}.\n"
            "ÖNEMLİ HİTAP KURALI: Öğrenciye hitap ederken 'Öğrenci' kelimesini bir insan ismiymiş gibi ('Harikasın Öğrenci', 'Aferin Öğrenci') KESİNLİKLE KULLANMA!\n"
            "Bunun yerine içten öğretmen hitapları kullan ('sevgili öğrencim', 'harika arkadaşım', 'şampiyon') ya da doğrudan eyleme geç ('Harika bir adım!', 'Çok güzel, şimdi devam edelim')."
        )

    system_prompt = (
        f"Sen {sgrade} öğrencisi ile çalışan, sevecen, sabırlı ve enerjik bir Ev Ödevi Öğretmenisin (Adın: {tname}).\n"
        f"{addr_rule}\n"
        "PEDAGOJİK VE DİYALOG KURALLARI:\n"
        "1. KISA VE AKICI KONUŞMA (TTS İÇİN UYGUN): spoken_text en fazla 2-3 kısa, samimi ve konuşma dilinde doğal Türkçe cümle olsun. Asla robotik veya karmaşık terminoloji kullanma.\n"
        "2. TEK TUR = TEK ADIM: Çocuğa aynı anda birden fazla soru sorma veya kafa karıştırıcı uzun açıklamalar yapma. Her turda sadece bir sonraki küçük adımı sor ve cevabını bekle.\n"
        "3. DUYGU VE MOTİVASYON YÖNETİMİ:\n"
        "   - Çocuk 'Anlamadım', 'Bilmiyorum' veya 'Sıkıldım' derse: Önce moral ver ve rahatlat. Ardından soruyu günlük hayattan somut, eğlenceli bir örnekle açıkla (pasta dilimi, harçlık hesabı, maç skoru vb.).\n"
        "   - Doğru cevap verdiğinde: Coşkuyla kutla (emotion='celebrate').\n"
        "   - Yanıldığında: Kırmadan, cesaretlendirerek küçük bir ipucu ver (emotion='encouraging', question_status='needs_retry').\n"
        "4. HAFIZA SÜREKLİLİĞİ: Ödev Hafızasında daha önce doğru verilen adımları veya 'solved' olmuş soruları asla tekrar sorma; kaldığınız yerden devam et.\n"
        "5. TAHTA SÜREKLİLİĞİ: Tahtaya yeni çözüm basamağı eklemek için whiteboard.action='append' kullan ve sadece yeni adımı yaz (önceki adımlar korunur). Tahtayı sıfırlayıp baştan yazmak için action='replace', yeni soruya geçerken tahtayı temizlemek için action='clear' kullan.\n"
        "6. SORU TAMAMLANMASI: Doğru sonuca ulaşıldığında kutla (emotion='celebrate', question_status='solved'). Öğrenci sıradakine geçmek istediğinde move_to_next_question=true yap ve yeni soruyu okuyup anlatarak başla.\n"
        "7. OTONOM HAFIZA YÖNETİMİ: Öğrencinin konuşması sırasında onun hakkında kalıcı olarak hatırlanması gereken bir bilgi (örn: ilgi alanı, hayali, yaklaşan sınavı, anlık durumu veya bir konuyu tamamen pekiştirmesi/zorlanması) ortaya çıkarsa 'memory_actions' listesine ekle veya güncelle:\n"
        "   - action: 'set' | 'update' | 'delete'\n"
        "   - key: 'ogrenci:ilgi' | 'ajanda:sinav' | 'akademik:konu' vb.\n"
        "   - value: 'Net açıklama'\n"
        "   - category: 'ogrenci' | 'akademik' | 'ajanda' | 'strateji'\n"
        f"{WHITEBOARD_SCHEMA_GUIDE}\n"
        "SADECE JSON döndür:\n"
        '{"spoken_text": "...", "emotion": "happy|thinking|celebrate|encouraging", '
        '"question_status": "in_progress|solved|needs_retry", '
        '"student_step_summary": "5-8 kelimelik adım özeti", '
        '"move_to_next_question": false, "whiteboard": {...}, '
        '"memory_actions": []}'
    )
    lt_block = ""
    if pedagogical_memory and pedagogical_memory.get("profile_notes"):
        lt_block += f"Öğrencinin Profil ve Hatırlama Notları: {json.dumps(pedagogical_memory['profile_notes'], ensure_ascii=False)}\n"
    if long_term_memory:
        lt_block += f"Uzun Dönem Öğrenme Hafızası: {json.dumps(long_term_memory, ensure_ascii=False)}\n"

    compaction_block = f"\n[Önceki Turların Pedagojik Özeti]:\n{compaction_briefing}\n" if compaction_briefing else ""

    wb_block = ""
    if current_whiteboard and isinstance(current_whiteboard, dict):
        wb_block = (
            f"Akıllı Tahtadaki Mevcut Durum:\n"
            f"- Başlık: {current_whiteboard.get('title', '')}\n"
            f"- Yazılı Adımlar: {json.dumps(current_whiteboard.get('steps', []), ensure_ascii=False)}\n"
            f"- Formül: {current_whiteboard.get('latex', '')}\n"
            f"- Çizim Şeması: {current_whiteboard.get('drawing', {}).get('type', 'none')}\n\n"
        )

    user_prompt = (
        f"Öğrenci: {sname} | Ders: {subject}\n"
        f"Aktif Soru: {json.dumps(active_question, ensure_ascii=False)}\n"
        f"Ödev Hafızası: {json.dumps(homework_memory, ensure_ascii=False)}\n"
        f"{wb_block}"
        f"{lt_block}"
        f"{compaction_block}"
        f"Son Konuşmalar:\n{chat_history}\n\n"
        f"Öğrencinin Cevabı: {student_text}"
    )
    lite = (os.getenv("GEMINI_LITE_MODEL") or "gemini-3.5-flash-lite").strip()
    result, tokens = _call_gemini(lite, system_prompt, [{"text": user_prompt}], json_mode=True, temperature=0.35)
    if not result and lite != "gemini-3.5-flash-lite":
        result, tokens = _call_gemini("gemini-3.5-flash-lite", system_prompt, [{"text": user_prompt}], json_mode=True, temperature=0.35)
    if not result:
        return {
            "spoken_text": "Bağlantıda kısa bir takılma oldu, cevabını bir kez daha paylaşır mısın?",
            "emotion": "thinking",
            "question_status": "in_progress",
            "student_step_summary": "",
            "move_to_next_question": False,
            "whiteboard": {},
        }, tokens
    return result, tokens


def introduce_resumed_question(
    subject: str,
    topic: str,
    question: Dict[str, Any],
    skipped_solved_nos: List[int],
    student_name: str = "",
    student_grade: str = "",
) -> Tuple[Dict[str, Any], int]:
    sname, sgrade = _resolve_student_info(student_name, student_grade)
    prev_answers = question.get("student_answers") or []
    if sname:
        addr_rule = f"Öğrencinin adı: {sname} ({sgrade}). Ona ismiyle hitap et."
    else:
        addr_rule = "Öğrenciye hitap ederken 'Öğrenci' kelimesini bir kişi adı gibi ASLA kullanma; 'sevgili öğrencim' de veya doğrudan soruya geç."

    system_prompt = (
        f"Sen bir öğrenci ile çalışan sevecen, sabırlı ve neşeli Ev Ödevi Öğretmeni Elif Öğretmen'sin.\n"
        f"{addr_rule}\n"
        "1. 'atlanan_cozulmus_sorular' doluysa önce onları daha önce tamamladığınızı neşeyle söyleyip geç.\n"
        "2. Sıradaki soruyu tane tane sesli oku ve ne istediğini sade, günlük dille anlat.\n"
        "3. spoken_text en fazla 2-3 kısa ve samimi Türkçe cümle olsun. Tek seferde sadece ilk adımı sor.\n"
        "4. 'onceki_cevaplar' varsa onları hatırla ve kaldığınız yerden devam et.\n"
        f"{WHITEBOARD_SCHEMA_GUIDE}\n"
        'SADECE JSON döndür: {"spoken_text": "...", "emotion": "happy|encouraging", "whiteboard": {...}}'
    )
    payload = json.dumps(
        {
            "ogrenci_adi": sname,
            "atlanan_cozulmus_sorular": skipped_solved_nos,
            "soru_no": question.get("question_no", 1),
            "ders": subject,
            "konu": topic,
            "soru_metni": question.get("question_text", ""),
            "latex": question.get("latex", ""),
            "onceki_cevaplar": prev_answers,
        },
        ensure_ascii=False,
    )
    lite = (os.getenv("GEMINI_LITE_MODEL") or "gemini-3.5-flash-lite").strip()
    result, tokens = _call_gemini(lite, system_prompt, [{"text": payload}], json_mode=True, temperature=0.3)
    if not result:
        skip_txt = f"Daha önce çözdüğümüz {', '.join(str(n)+'.' for n in skipped_solved_nos)} soruları geçiyorum. " if skipped_solved_nos else ""
        return {
            "spoken_text": f"{skip_txt}Şimdi {question.get('question_no', 1)}. soruyu okuyalım: {question.get('question_text', '')} Bu sorunun bizden ne istediğini anladın mı?",
            "emotion": "happy",
            "whiteboard": {
                "title": f"{subject} • Soru {question.get('question_no', 1)}",
                "steps": [f"Soru {question.get('question_no', 1)}: {question.get('question_text', '')}"],
                "latex": question.get("latex", ""),
                "drawing": {"type": "none", "params": {}},
            },
        }, tokens
    return result, tokens


def pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 24000, num_channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """Raw PCM verisine standart 44-byte RIFF/WAV başlığı ekleyerek tüm tarayıcıların sorunsuz çalmasını sağlar."""
    byte_rate = sample_rate * num_channels * (bits_per_sample // 8)
    block_align = num_channels * (bits_per_sample // 8)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        len(pcm_bytes) + 36,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        num_channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        len(pcm_bytes),
    )
    return header + pcm_bytes


def synthesize_tts(text: str, voice: str = "Aoede") -> Tuple[bytes, str]:
    key = _get_key()
    if not key:
        raise RuntimeError("GOOGLE_API_KEY tanımlı değil.")
    candidates = [
        (os.getenv("GEMINI_TTS_MODEL") or "").strip(),
        "gemini-2.5-flash-preview-tts",
        "gemini-3.1-flash-tts-preview",
        "gemini-3.8-flash-lite-tts",
        "gemini-3.8-flash-tts",
    ]
    candidates = [m for m in candidates if m]
    last_err = None
    for model in candidates:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": text.strip()}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice or "Aoede"}}},
            },
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                for p in body.get("candidates", [{}])[0].get("content", {}).get("parts", []):
                    inline = p.get("inlineData") or p.get("inline_data")
                    if inline and inline.get("data"):
                        raw_data = base64.b64decode(inline["data"])
                        raw_mime = inline.get("mimeType") or "audio/wav"
                        # Gemini audio/l16 (raw PCM) döndürdüğünde HTML5 Audio elementleri RIFF başlığı olmadan çalamaz
                        if not raw_data.startswith(b"RIFF"):
                            m_rate = re.search(r"rate=(\d+)", raw_mime)
                            s_rate = int(m_rate.group(1)) if m_rate else 24000
                            raw_data = pcm_to_wav(raw_data, sample_rate=s_rate)
                            raw_mime = "audio/wav"
                        return raw_data, raw_mime
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"TTS ses üretilemedi: {last_err}")


def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/webm") -> str:
    key = _get_key()
    if not key:
        return ""
    stt_model = (os.getenv("GEMINI_STT_MODEL") or "gemini-3.5-transcribe").strip()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{stt_model}:generateContent?key={key}"
    clean_mime = (mime_type or "audio/webm").split(";")[0].strip()
    b64 = base64.b64encode(audio_bytes).decode("ascii")
    payload = {
        "contents": [
            {
                "parts": [
                    {
                        "text": "Bu ses kaydında konuşan öğrencinin söylediklerini Türkçe olarak yazıya dök. Sadece konuşulan metni yaz, başına veya sonuna hiçbir açıklama, selamlama veya tırnak işareti ekleme."
                    },
                    {
                        "inline_data": {
                            "mime_type": clean_mime,
                            "data": b64,
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.0,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            candidates = body.get("candidates") or []
            if not candidates:
                return ""
            parts = candidates[0].get("content", {}).get("parts", [])
            txt = "".join(p.get("text", "") for p in parts).strip()
            if (txt.startswith('"') and txt.endswith('"')) or (txt.startswith("'") and txt.endswith("'")):
                txt = txt[1:-1].strip()
            return txt
    except Exception as e:
        if frappe:
            try:
                frappe.log_error(f"Gemini STT error ({stt_model}): {e}", "elif_tutor.stt")
            except Exception:
                pass
        return ""

