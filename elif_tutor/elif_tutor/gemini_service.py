from __future__ import annotations

import base64
import json
import os
import re
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import frappe


def _get_key() -> str:
    k = (os.getenv("GOOGLE_API_KEY") or frappe.conf.get("google_api_key") or "").strip()
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
        frappe.log_error(f"Gemini error ({model}): {e}", "elif_tutor.gemini")
        return None, 0


WHITEBOARD_SCHEMA_GUIDE = """
Tahta çizim komutları (whiteboard JSON):
{
  "title": "Tahta Başlığı",
  "steps": ["Verilenler: ...", "Bizden İstenen: ..."],
  "latex": "Varsa KaTeX ifadesi",
  "drawing": {
    "type": "none | fraction_bar | geometry_triangle | geometry_rectangle | number_line | solar_system | electric_circuit | english_card | concept_map",
    "params": {}
  }
}
"""


def _student_name() -> str:
    return (os.getenv("STUDENT_NAME") or frappe.conf.get("student_name") or "Öğrenci").strip()


def _student_grade() -> str:
    return (os.getenv("STUDENT_GRADE") or frappe.conf.get("student_grade") or "5. Sınıf").strip()


def analyze_homework_page(
    file_bytes: bytes,
    mime_type: str,
    subject_hint: str,
    student_note: str = "",
    long_term_memory: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[Dict[str, Any], int]:
    """Ödev sayfasını tek seferlik görsel analiz ile okur, soruları ve kontrol durumunu çıkarır."""
    b64 = base64.b64encode(file_bytes).decode("ascii")
    sname = _student_name()
    sgrade = _student_grade()
    system_prompt = (
        f"Sen {sgrade} öğrencisi {sname} ile birebir ev ödevi çalışan sevecen bir Sanal Öğretmensin (Adın: Elif Öğretmen).\n"
        f"Öğrencinin adı: {sname}. Konuşmalarında ona doğal ve sıcak biçimde hitap et.\n"
        "ÖDEV KONTROL VE ANLATIM AKIŞI:\n"
        "1. Sayfadaki tüm soruları 'questions' dizisine çıkar ve kağıtta yazılı/işaretli cevap var mı kontrol et:\n"
        "   - Cevap yazılmış ve doğruysa -> paper_check='correct', student_written_answer='yazılı cevap'.\n"
        "   - Cevap yazılmış ve yanlışsa -> paper_check='wrong', student_written_answer='yazılı cevap', mistake_reason='neden yanlış olduğu ve nasıl düşünüleceği'.\n"
        "   - Boş / yapılmamışsa -> paper_check='blank', student_written_answer=''.\n"
        "2. Konuşma metni ('spoken_text') ve tahta ('whiteboard'):\n"
        "   - Kağıtta yanlış varsa: önce doğruları tebrik et, sonra ilk yanlış soruda neden yanlış olduğunu ve çözüm yolunu anlatıp ilk adımı sor (sonucu direkt söyleme).\n"
        "   - Tüm sorular doğruysa: tebrik et (emotion='celebrate') ve ödevin bittiğini bildir.\n"
        "   - Ödev boşsa: 1. soruyu tane tane oku, günlük dille ne istediğini açıkla, tahtaya Verilenler/İstenen koy ve anladığını kontrol edip 1. adımı sor.\n"
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
    model = (os.getenv("GEMINI_VISION_MODEL") or "gemini-3.8-flash").strip()
    result, tokens = _call_gemini(model, system_prompt, parts, json_mode=True, temperature=0.2)
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
) -> Tuple[Dict[str, Any], int]:
    sname = _student_name()
    sgrade = _student_grade()
    chat_history = "\n".join(f"{m.get('role')}: {m.get('text')}" for m in recent_messages[-6:])
    system_prompt = (
        f"Sen {sgrade} öğrencisi {sname} ile çalışan birebir Ev Ödevi Öğretmenisin (Elif Öğretmen).\n"
        "KURALLAR:\n"
        "1. Ödev Hafızasında daha önce doğru verilen adımları veya 'solved' olmuş soruları asla tekrar sorma; kaldığınız yerden ilerle.\n"
        "2. Uzun Dönem Öğrenme Hafızasında önceki ödevlerden ilgili bir not varsa uygun olduğunda kısaca hatırlat.\n"
        "3. Öğrenci anlamadığını söylerse günlük hayattan basit bir örnekle yeniden anlat.\n"
        "4. Doğru adımlarda tebrik et, tahtayı güncelle, sonraki küçük adımı sor. Yanlışta kırmadan görsel ipucu ver (question_status='needs_retry').\n"
        "5. Doğru sonuca ulaşıldığında kutla (emotion='celebrate', question_status='solved') ve sayfada kalan soru varsa sıradakine geçmeyi öner.\n"
        "6. Aktif soru çözüldüyse ve öğrenci sıradakine geçmek isterse move_to_next_question=true döndür ve yeni soruyu okuyup anlatarak başla.\n"
        "7. spoken_text 2-4 doğal Türkçe cümle olsun.\n"
        f"{WHITEBOARD_SCHEMA_GUIDE}\n"
        "SADECE JSON döndür:\n"
        '{"spoken_text": "...", "emotion": "happy|thinking|celebrate|encouraging", '
        '"question_status": "in_progress|solved|needs_retry", '
        '"student_step_summary": "5-8 kelimelik adım özeti", '
        '"move_to_next_question": false, "whiteboard": {...}}'
    )
    lt_block = (
        f"Uzun Dönem Öğrenme Hafızası: {json.dumps(long_term_memory, ensure_ascii=False)}\n"
        if long_term_memory else ""
    )
    user_prompt = (
        f"Öğrenci: {sname} | Ders: {subject}\n"
        f"Aktif Soru: {json.dumps(active_question, ensure_ascii=False)}\n"
        f"Ödev Hafızası: {json.dumps(homework_memory, ensure_ascii=False)}\n"
        f"{lt_block}"
        f"Son Konuşmalar:\n{chat_history}\n\n"
        f"Öğrencinin Cevabı: {student_text}"
    )
    lite = (os.getenv("GEMINI_LITE_MODEL") or "gemini-3.5-flash-lite").strip()
    result, tokens = _call_gemini(lite, system_prompt, [{"text": user_prompt}], json_mode=True, temperature=0.35)
    if not result:
        fb = (os.getenv("GEMINI_VISION_MODEL") or "gemini-3.8-flash").strip()
        result, tokens = _call_gemini(fb, system_prompt, [{"text": user_prompt}], json_mode=True, temperature=0.35)
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
) -> Tuple[Dict[str, Any], int]:
    sname = _student_name()
    prev_answers = question.get("student_answers") or []
    system_prompt = (
        f"Sen {sname} ile çalışan Ev Ödevi Öğretmeni Elif Öğretmen'sin.\n"
        "1. 'atlanan_cozulmus_sorular' doluysa önce onları daha önce çözdüğünüzü söyleyip geç.\n"
        "2. Sıradaki soruyu tane tane sesli oku ve ne istediğini sade dille anlat.\n"
        "3. 'onceki_cevaplar' varsa onları hatırla ve kaldığınız yerden devam et.\n"
        "4. Cevabı direkt söyleme; anladığını kontrol edip birlikte 1. adıma davet et.\n"
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
                "steps": [f"📌 Soru {question.get('question_no', 1)}: {question.get('question_text', '')}"],
                "latex": question.get("latex", ""),
                "drawing": {"type": "none", "params": {}},
            },
        }, tokens
    return result, tokens


def synthesize_tts(text: str, voice: str = "Aoede") -> Tuple[bytes, str]:
    key = _get_key()
    if not key:
        raise RuntimeError("GOOGLE_API_KEY tanımlı değil.")
    tts_model = (os.getenv("GEMINI_TTS_MODEL") or "gemini-3.8-flash-tts").strip()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{tts_model}:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": text.strip()}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        for p in body.get("candidates", [{}])[0].get("content", {}).get("parts", []):
            inline = p.get("inlineData") or p.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"]), inline.get("mimeType") or "audio/wav"
    raise RuntimeError("TTS ses üretilemedi.")
