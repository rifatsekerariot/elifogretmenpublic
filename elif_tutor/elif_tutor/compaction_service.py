from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

COMPACTION_TRIGGER_TURNS = 3  # 6 mesaj (3 karşılıklı diyalog turu)
MAX_ACTIVE_RECENT_MESSAGES = 4


def should_compact(messages: List[Dict[str, Any]], trigger_turns: int = COMPACTION_TRIGGER_TURNS) -> bool:
    """Mesaj geçmişi eşiği aştığında bağlam sıkıştırmayı tetikler."""
    if not messages or len(messages) < (trigger_turns * 2):
        return False
    # Son mesaj zaten bir özet kartıysa tekrar özetleme
    if messages and messages[0].get("is_compaction_summary"):
        uncompacted = [m for m in messages[1:] if not m.get("is_compaction_summary")]
        return len(uncompacted) >= (trigger_turns * 2)
    return len(messages) >= (trigger_turns * 2)


def extract_deterministic_context(
    messages: List[Dict[str, Any]],
    active_question: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Pass 1: Mesaj geçmişinden deterministik veri çıkarımı (LLM çağrısız, sıfır maliyet).
    Öğrencinin denediği cevapları, matematiksel ara değerleri ve öğretmenin ipuçlarını ayıklar.
    """
    student_trials: List[str] = []
    teacher_hints: List[str] = []
    extracted_math: List[str] = []

    math_pattern = re.compile(r"(\b\d+/\d+\b|\b\d+\b|[xXyYzZ]\s*=\s*\d+|[+\-*/=])")

    for msg in messages:
        role = str(msg.get("role", "")).lower()
        text = str(msg.get("text", "")).strip()
        if not text or msg.get("is_compaction_summary"):
            continue

        if "öğrenci" in role:
            student_trials.append(text[:200])
            for m in math_pattern.findall(text):
                if m not in extracted_math and len(m) > 1:
                    extracted_math.append(m)
        elif "öğretmen" in role or "teacher" in role:
            teacher_hints.append(text[:200])

    q_text = ""
    q_no = 1
    if active_question:
        q_text = active_question.get("question_text", "")
        q_no = active_question.get("question_no", 1)

    return {
        "question_no": q_no,
        "question_text": q_text,
        "student_trials": student_trials[-6:],
        "teacher_hints": teacher_hints[-4:],
        "extracted_math_tokens": extracted_math[-8:],
        "total_turns": len(messages) // 2,
    }


def build_compact_briefing(
    extracted: Dict[str, Any],
    subject: str = "Matematik",
    llm_synthesized: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Pass 2: Çıkarılan bağlamı pedagojik Antigravity standardında yapılandırılmış brife dönüştürür.
    """
    if llm_synthesized and llm_synthesized.get("briefing"):
        return llm_synthesized["briefing"].strip()

    q_no = extracted.get("question_no", 1)
    q_txt = extracted.get("question_text", "")
    trials = extracted.get("student_trials", [])
    hints = extracted.get("teacher_hints", [])
    tokens = extracted.get("extracted_math_tokens", [])

    lines = [
        f"[ÖDEV ADIM ÖZETİ — Soru {q_no}]",
        f"• Soru: {q_txt[:90]}" if q_txt else f"• Ders: {subject}",
    ]

    if tokens:
        lines.append(f"• Tespit Edilen Ara Değerler: {', '.join(tokens[:5])}")

    if trials:
        lines.append(f"• Öğrencinin Son Denemeleri: \"{trials[-1][:80]}\"")

    if hints:
        lines.append(f"• Verilen Son Yönlendirme: \"{hints[-1][:80]}\"")

    lines.append("• Pedagojik Hedef: Doğru cevabı direkt söylemeden sonraki mikro adımı buldurmak.")
    return "\n".join(lines)


def compact_messages(
    messages: List[Dict[str, Any]],
    active_question: Optional[Dict[str, Any]] = None,
    subject: str = "Matematik",
    max_recent: int = MAX_ACTIVE_RECENT_MESSAGES,
) -> Tuple[List[Dict[str, Any]], str]:
    """
    Kayan pencereyi özet enjeksiyonuyla sıkıştırır:
    - Eski mesajları süzüp kompakt brife çevirir.
    - Başa tek bir [ÖDEV ADIM ÖZETİ] kartı koyar.
    - Son N aktif canlı mesajı korur.
    """
    if not should_compact(messages):
        return messages, ""

    extracted = extract_deterministic_context(messages, active_question)
    briefing = build_compact_briefing(extracted, subject)

    recent_tail = [m for m in messages if not m.get("is_compaction_summary")][-max_recent:]

    summary_message = {
        "role": "Sistem (Pedagojik Özet)",
        "text": briefing,
        "is_compaction_summary": True,
        "time": "Özet",
    }

    compacted = [summary_message] + recent_tail
    return compacted, briefing
