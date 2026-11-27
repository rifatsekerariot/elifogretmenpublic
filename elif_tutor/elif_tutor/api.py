from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

import frappe
from frappe.utils import get_datetime, now_datetime

from elif_tutor.compaction_service import compact_messages
from elif_tutor.gemini_service import (
    analyze_homework_page,
    apply_whiteboard_action,
    chat_socratic_turn,
    introduce_resumed_question,
    synthesize_tts,
    transcribe_audio,
)
from elif_tutor.memory_service import (
    apply_autonomous_memory_actions,
    get_relevant_long_term_memory,
    list_learning_memories,
    recall_pedagogical_memories,
    record_learning_memory,
)

VALID_SUBJECTS = {"Matematik", "Fen Bilimleri", "Türkçe", "İngilizce", "Sosyal Bilgiler", "Din Kültürü"}
ALLOWED_EXT_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB
MAX_CHAT_CHARS = 2000
MAX_TTS_CHARS = 1500
MAX_NOTE_CHARS = 500


def _detect_magic_mime(data: bytes) -> Optional[str]:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    return None


def _validate_upload(filename: str, mime: str, data: bytes) -> str:
    if not data:
        frappe.throw("Boş dosya gönderildi.")
    if len(data) > MAX_UPLOAD_BYTES:
        frappe.throw("Dosya boyutu 15 MB sınırını aşıyor.")
    safe_name = os.path.basename(filename or "odev.jpg")
    ext = ("." + safe_name.rsplit(".", 1)[-1].lower()) if "." in safe_name else ""
    expected_mime = ALLOWED_EXT_MIME.get(ext)
    actual_mime = _detect_magic_mime(data)
    if not expected_mime or actual_mime != expected_mime or (mime and mime.lower() != expected_mime):
        frappe.throw("Yalnızca geçerli JPG, PNG, WEBP veya PDF formatında ödev sayfası yüklenebilir.")
    return safe_name


def _require_login():
    if frappe.session.user == "Guest":
        frappe.throw("Ödev ekranını kullanmak için giriş yapmalısınız.", frappe.PermissionError)


def _norm_q(text: str) -> str:
    clean = re.sub(r"[^a-z0-9çğıöşü]+", " ", (text or "").lower()).strip()
    return re.sub(r"\s+", " ", clean)


def _get_student_name_and_grade(user_id: Optional[str] = None) -> Tuple[str, str]:
    target_user = user_id or (getattr(frappe, "session", None) and getattr(frappe.session, "user", None))
    sname = ""
    sgrade = ""
    if target_user and target_user not in ("Guest", "None"):
        try:
            fn = frappe.db.get_value("User", target_user, "first_name")
            full = frappe.db.get_value("User", target_user, "full_name")
            if fn and fn.strip() and fn.lower() not in ("administrator", "admin", "guest"):
                sname = fn.strip()
            elif full and full.strip() and full.lower() not in ("administrator", "admin", "guest"):
                sname = full.strip().split()[0]
        except Exception:
            pass
    if not sname:
        n = (os.getenv("STUDENT_NAME") or "").strip()
        if n and n.lower() not in ("öğrenci", "ogrenci", "student"):
            sname = n
    if not sgrade:
        sgrade = (os.getenv("STUDENT_GRADE") or "5. Sınıf").strip()
    if sname.lower() in ("öğrenci", "ogrenci", "student", "null", "none"):
        sname = ""
    return sname, sgrade


def _q_hash(text: str) -> str:
    return hashlib.sha256(_norm_q(text).encode("utf-8")).hexdigest()[:32]


def _word_sim(a: str, b: str) -> float:
    sa = set(_norm_q(a).split())
    sb = set(_norm_q(b).split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _serialize_sheet(doc) -> Dict[str, Any]:
    questions = []
    for row in (doc.questions or []):
        try:
            ans = json.loads(row.student_answers_json or "[]")
        except Exception:
            ans = []
        questions.append({
            "name": row.name,
            "question_no": int(row.question_no or 1),
            "question_text": row.question_text or "",
            "latex": row.latex or "",
            "status": row.status or "pending",
            "attempts": int(row.attempts or 0),
            "duration_seconds": int(row.duration_seconds or 0),
            "student_answers": ans,
        })
    try:
        wb = json.loads(doc.whiteboard_json or "{}")
    except Exception:
        wb = {}
    try:
        msgs = json.loads(doc.messages_json or "[]")
    except Exception:
        msgs = []
    return {
        "sheet_id": doc.name,
        "title": doc.title,
        "subject": doc.subject,
        "topic": doc.topic or "",
        "status": doc.status,
        "started_at": str(doc.started_at or ""),
        "completed_at": str(doc.completed_at or ""),
        "duration_seconds": int(doc.duration_seconds or 0),
        "total_questions": int(doc.total_questions or 0),
        "solved_questions": int(doc.solved_questions or 0),
        "time_score": int(doc.time_score or 0),
        "time_grade": doc.time_grade or "Devam Ediyor",
        "tokens_used": int(doc.tokens_used or 0),
        "active_question_no": int(doc.active_question_no or 1),
        "image_data": getattr(doc, "image_data", "") or getattr(doc, "original_file_url", "") or "",
        "whiteboard": wb,
        "messages": msgs,
        "questions": questions,
    }


def _find_existing_sheet_for_questions(extracted: List[Dict[str, Any]], user: str) -> Optional[str]:
    """Aynı ödev sayfası daha önce yüklendiyse mevcut Homework Sheet kaydını bulur."""
    hashes = [_q_hash(q.get("text") or "") for q in extracted if q.get("text")]
    if not hashes:
        return None

    rows = frappe.get_all(
        "Homework Question Item",
        filters={"question_hash": ["in", hashes]},
        fields=["parent"],
        limit=10,
    )
    for r in rows:
        if frappe.db.exists("Homework Sheet", {"name": r.parent, "owner_user": user}):
            return r.parent

    # Bulanık eşleşme (OCR küçük farkları için son 20 ödev sayfasında ara)
    recent_sheets = frappe.get_all(
        "Homework Sheet",
        filters={"owner_user": user},
        fields=["name"],
        order_by="modified desc",
        limit=20,
    )
    first_text = extracted[0].get("text") or ""
    for sh in recent_sheets:
        qrows = frappe.get_all("Homework Question Item", filters={"parent": sh.name}, fields=["question_text"])
        for qr in qrows:
            if _word_sim(first_text, qr.question_text or "") >= 0.72:
                return sh.name
    return None


@frappe.whitelist()
def list_sheets(subject: Optional[str] = None):
    _require_login()
    filters: Dict[str, Any] = {"owner_user": frappe.session.user}
    if subject and subject != "Tümü":
        filters["subject"] = subject
    rows = frappe.get_all(
        "Homework Sheet",
        filters=filters,
        fields=[
            "name", "title", "subject", "topic", "status", "started_at", "completed_at",
            "duration_seconds", "total_questions", "solved_questions", "time_score",
            "time_grade", "tokens_used", "modified",
        ],
        order_by="modified desc",
        limit=40,
    )
    return {
        "count": len(rows),
        "memories": list_learning_memories(frappe.session.user),
        "sheets": [
            {
                "sheet_id": r.name,
                "title": r.title,
                "subject": r.subject,
                "topic": r.topic or "",
                "status": r.status,
                "started_at": str(r.started_at or ""),
                "completed_at": str(r.completed_at or ""),
                "duration_seconds": int(r.duration_seconds or 0),
                "total_questions": int(r.total_questions or 0),
                "solved_questions": int(r.solved_questions or 0),
                "time_score": int(r.time_score or 0),
                "time_grade": r.time_grade or "Devam Ediyor",
                "tokens_used": int(r.tokens_used or 0),
            }
            for r in rows
        ],
    }


@frappe.whitelist()
def upload_homework_page(subject: str = "Matematik", note: str = ""):
    _require_login()
    f = frappe.request.files.get("file")
    if not f:
        frappe.throw("Ödev dosyası bulunamadı.")
    file_bytes = f.read(MAX_UPLOAD_BYTES + 1)
    mime = (f.mimetype or "image/jpeg").lower()
    fname = _validate_upload(f.filename or "odev.jpg", mime, file_bytes)
    note = (note or "").strip()[:MAX_NOTE_CHARS]

    sname, sgrade = _get_student_name_and_grade(frappe.session.user)
    lt_mem = get_relevant_long_term_memory(frappe.session.user, subject, topic="", query_text=note, limit=2)
    res, tokens = analyze_homework_page(file_bytes, mime, subject, note, long_term_memory=lt_mem, student_name=sname, student_grade=sgrade)
    subj = res.get("subject") if res.get("subject") in VALID_SUBJECTS else subject
    topic = (res.get("topic") or subj)[:80]
    extracted = res.get("questions") or []
    if not extracted:
        return {
            "sheet": None,
            "spoken_text": res.get("spoken_text", "Sayfa okunamadı."),
            "emotion": res.get("emotion", "encouraging"),
            "whiteboard": res.get("whiteboard") or {},
        }

    # Kağıtta kontrol edilen doğru/yanlışları uzun dönem öğrenme hafızasına işle
    for q in extracted:
        pc = (q.get("paper_check") or "blank").strip().lower()
        if pc == "correct":
            record_learning_memory(frappe.session.user, subj, topic, solved_delta=1)
        elif pc == "wrong":
            record_learning_memory(
                frappe.session.user,
                subj,
                topic,
                mistake_delta=1,
                struggle_note=(q.get("mistake_reason") or f"Kağıtta yanlış cevap: {q.get('student_written_answer', '')}"),
            )

    # Mevcut ödev sayfasıyla eşleşiyor mu kontrol et (baştan başlamama garantisi!)
    existing_name = _find_existing_sheet_for_questions(extracted, frappe.session.user)
    now_t = datetime.now().strftime("%H:%M")

    if existing_name:
        doc = frappe.get_doc("Homework Sheet", existing_name)
        # Aynı kağıt cevaplanıp tekrar yüklendiyse: yeni kağıt cevaplarını mevcut hafızayla akıllıca birleştir (zaten 'solved' olanları ASLA bozma!)
        for q in extracted:
            qtxt = (q.get("text") or "").strip()
            if not qtxt:
                continue
            qh = _q_hash(qtxt)
            matched_row = next((r for r in doc.questions if r.question_hash == qh or _word_sim(qtxt, r.question_text or "") >= 0.72), None)
            if not matched_row or matched_row.status == "solved":
                continue
            pcheck = (q.get("paper_check") or "blank").strip().lower()
            written = (q.get("student_written_answer") or "").strip()
            reason = (q.get("mistake_reason") or "").strip()
            ans_list = json.loads(matched_row.student_answers_json or "[]")
            if pcheck == "correct":
                matched_row.status = "solved"
                matched_row.completed_at = now_datetime()
                if written:
                    ans_list.append(f"[Kağıtta doğru]: {written}")
                matched_row.student_answers_json = json.dumps(ans_list[-12:], ensure_ascii=False)
            elif pcheck == "wrong":
                matched_row.status = "needs_retry"
                matched_row.attempts = int(matched_row.attempts or 0) + 1
                if written:
                    entry = f"[Kağıttaki yanlış cevap]: {written}" + (f" ({reason})" if reason else "")
                    ans_list.append(entry)
                matched_row.student_answers_json = json.dumps(ans_list[-12:], ensure_ascii=False)
    else:
        # Dosyayı Frappe File olarak arşivle
        file_doc = frappe.get_doc({
            "doctype": "File",
            "file_name": fname,
            "content": file_bytes,
            "is_private": 1,
        }).insert(ignore_permissions=True)

        title = f"{subj} — {topic[:36]}" if topic != subj else f"{subj} Ödevi ({datetime.now().strftime('%d.%m %H:%M')})"
        doc = frappe.get_doc({
            "doctype": "Homework Sheet",
            "title": title,
            "owner_user": frappe.session.user,
            "subject": subj,
            "topic": topic,
            "homework_file": file_doc.file_url,
            "started_at": now_datetime(),
            "status": "in_progress",
            "tokens_used": 0,
            "messages_json": "[]",
            "whiteboard_json": "{}",
        })
        for idx, q in enumerate(extracted, start=1):
            qtxt = (q.get("text") or "").strip()
            if not qtxt:
                continue
            pcheck = (q.get("paper_check") or "blank").strip().lower()
            written = (q.get("student_written_answer") or "").strip()
            reason = (q.get("mistake_reason") or "").strip()
            init_status = "pending"
            init_answers: List[str] = []
            init_attempts = 0
            init_completed = None
            if pcheck == "correct":
                init_status = "solved"
                init_completed = now_datetime()
                if written:
                    init_answers.append(f"[Kağıtta doğru]: {written}")
            elif pcheck == "wrong":
                init_status = "needs_retry"
                init_attempts = 1
                if written:
                    init_answers.append(f"[Kağıttaki yanlış cevap]: {written}" + (f" ({reason})" if reason else ""))
            doc.append("questions", {
                "question_no": int(q.get("no") or idx),
                "question_hash": _q_hash(qtxt),
                "question_text": qtxt,
                "latex": q.get("latex") or "",
                "correct_solution_hidden": q.get("correct_solution_hidden") or "",
                "status": init_status,
                "student_answers_json": json.dumps(init_answers, ensure_ascii=False),
                "attempts": init_attempts,
                "duration_seconds": 0,
                "started_at": now_datetime() if init_status != "pending" else None,
                "completed_at": init_completed,
            })
        doc.insert(ignore_permissions=True)

    solved_nos = [int(r.question_no) for r in doc.questions if r.status == "solved"]
    # Öncelik: 1) Kağıtta YANLIŞ yapılan sorular (needs_retry), 2) Boş/devam eden sorular
    wrong_rows = [r for r in doc.questions if r.status == "needs_retry"]
    unsolved = wrong_rows + [r for r in doc.questions if r.status not in ("solved", "needs_retry")]

    extra_tokens = 0
    spoken = res.get("spoken_text") or ""
    emotion = res.get("emotion") or "happy"
    wb = res.get("whiteboard") or {}

    if not unsolved:
        doc.save(ignore_permissions=True)
        if existing_name:
            spoken = (
                f"Aferin! '{doc.title}' ödevindeki tüm soruları ({doc.total_questions} soru) "
                f"başarıyla tamamlamışsın! Ödev Zamanı Notun: {doc.time_grade}. Yeni bir ödev sayfası yükleyebilirsin."
            )
        emotion = "celebrate"
        wb = {
            "title": f"{doc.title} • {doc.time_grade}",
            "steps": [f"Soru {r.question_no} (Tamamlandı): {(r.question_text or '')[:85]}" for r in doc.questions],
            "latex": "",
            "drawing": {"type": "none", "params": {}},
        }
    else:
        active_row = unsolved[0]
        if active_row.status == "pending":
            active_row.status = "in_progress"
            active_row.started_at = now_datetime()
        doc.active_question_no = int(active_row.question_no)

        prev_ans = json.loads(active_row.student_answers_json or "[]")
        if existing_name and (solved_nos or prev_ans):
            intro, extra_tokens = introduce_resumed_question(
                doc.subject,
                doc.topic or doc.subject,
                {
                    "question_no": active_row.question_no,
                    "question_text": active_row.question_text,
                    "latex": active_row.latex,
                    "student_answers": prev_ans,
                },
                skipped_solved_nos=solved_nos,
            )
            spoken = intro.get("spoken_text") or spoken
            emotion = intro.get("emotion") or "happy"
            if intro.get("whiteboard"):
                wb = intro["whiteboard"]

    msgs = json.loads(doc.messages_json or "[]")
    msgs.append({"role": "Öğrenci (Ödev Sayfası)", "text": note or f"{doc.title} ({len(doc.questions)} soru)", "time": now_t})
    msgs.append({"role": tname, "text": spoken, "emotion": emotion, "time": now_t})

    doc.messages_json = json.dumps(msgs[-40:], ensure_ascii=False)
    doc.whiteboard_json = json.dumps(wb, ensure_ascii=False)
    doc.tokens_used = int(doc.tokens_used or 0) + tokens + extra_tokens
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"sheet": _serialize_sheet(doc), "spoken_text": spoken, "emotion": emotion}


@frappe.whitelist()
def open_sheet(sheet_id: str, question_no: Optional[int] = None):
    _require_login()
    doc = frappe.get_doc("Homework Sheet", sheet_id)
    if doc.owner_user != frappe.session.user and "System Manager" not in frappe.get_roles():
        frappe.throw("Bu ödeve erişim yetkiniz yok.", frappe.PermissionError)

    solved_nos = [int(r.question_no) for r in doc.questions if r.status == "solved"]
    target_row = None
    if question_no is not None:
        target_row = next((r for r in doc.questions if int(r.question_no) == int(question_no)), None)
    if not target_row:
        target_row = next((r for r in doc.questions if r.status != "solved"), None)

    now_t = datetime.now().strftime("%H:%M")
    if not target_row:
        mins, secs = divmod(int(doc.duration_seconds or 0), 60)
        spoken = (
            f"Harika! '{doc.title}' ödevindeki tüm soruları {mins} dakika {secs} saniyede bitirmişsin! "
            f"Ödev Zamanı Notun: {doc.time_grade}."
        )
        emotion = "celebrate"
    else:
        if target_row.status == "pending":
            target_row.status = "in_progress"
            target_row.started_at = now_datetime()
        doc.active_question_no = int(target_row.question_no)
        prev_ans = json.loads(target_row.student_answers_json or "[]")
        intro, tokens = introduce_resumed_question(
            doc.subject,
            doc.topic or doc.subject,
            {
                "question_no": target_row.question_no,
                "question_text": target_row.question_text,
                "latex": target_row.latex,
                "student_answers": prev_ans,
            },
            skipped_solved_nos=[] if question_no is not None else solved_nos,
        )
        spoken = intro.get("spoken_text") or f"Soru {target_row.question_no}: {target_row.question_text}"
        emotion = intro.get("emotion") or "happy"
        if intro.get("whiteboard"):
            doc.whiteboard_json = json.dumps(intro["whiteboard"], ensure_ascii=False)
        doc.tokens_used = int(doc.tokens_used or 0) + tokens
        msgs = json.loads(doc.messages_json or "[]")
        msgs.append({"role": tname, "text": spoken, "emotion": emotion, "time": now_t})
        doc.messages_json = json.dumps(msgs[-40:], ensure_ascii=False)
        doc.save(ignore_permissions=True)
        frappe.db.commit()

    return {"sheet": _serialize_sheet(doc), "spoken_text": spoken, "emotion": emotion}


@frappe.whitelist()
def chat_turn(sheet_id: str, text: str, teacher_name: str = "Elif Öğretmen", teacher_gender: str = "female"):
    _require_login()
    student_msg = (text or "").strip()[:MAX_CHAT_CHARS]
    tname = (teacher_name or "Elif Öğretmen").strip()
    if not student_msg:
        frappe.throw("Boş cevap gönderilemez.")

    doc = frappe.get_doc("Homework Sheet", sheet_id)
    if doc.owner_user != frappe.session.user and "System Manager" not in frappe.get_roles():
        frappe.throw("Bu ödeve erişim yetkiniz yok.", frappe.PermissionError)

    prev_sheet_status = doc.status
    active_row = next((r for r in doc.questions if int(r.question_no) == int(doc.active_question_no or 1)), None)
    if not active_row and doc.questions:
        active_row = next((r for r in doc.questions if r.status != "solved"), doc.questions[0])

    # Aktif tur süresi (mola şişmesini önlemek için max 600 sn)
    delta_sec = 15
    try:
        prev_dt = get_datetime(doc.modified)
        elapsed = int((now_datetime() - prev_dt).total_seconds())
        delta_sec = max(5, min(elapsed, 600))
    except Exception:
        delta_sec = 15

    msgs = json.loads(doc.messages_json or "[]")
    now_t = datetime.now().strftime("%H:%M")
    msgs.append({"role": "Öğrenci", "text": student_msg, "time": now_t})

    prev_ans = json.loads(active_row.student_answers_json or "[]") if active_row else []
    pending_list = [
        {"no": int(r.question_no), "text": r.question_text, "status": r.status}
        for r in doc.questions
        if r.status != "solved" and (not active_row or r.name != active_row.name)
    ]
    solved_nos = [int(r.question_no) for r in doc.questions if r.status == "solved"]

    active_q_dict = {
        "question_no": int(active_row.question_no) if active_row else 1,
        "question_text": active_row.question_text if active_row else "",
        "latex": active_row.latex if active_row else "",
        "correct_solution_hidden": active_row.correct_solution_hidden if active_row else "",
    }
    compacted_msgs, briefing = compact_messages(msgs, active_q_dict, subject=doc.subject)

    target_user = doc.owner_user or frappe.session.user
    pedagogical_mem = recall_pedagogical_memories(
        target_user,
        doc.subject,
        topic=doc.topic or "",
        query_text=f"{active_row.question_text if active_row else ''} {student_msg}",
        limit=3,
    )

    try:
        curr_wb = json.loads(doc.whiteboard_json or "{}")
    except Exception:
        curr_wb = {}

    tname = teacher_name or "Elif Öğretmen"
    sname, sgrade = _get_student_name_and_grade(target_user)

    res, tokens = chat_socratic_turn(
        subject=doc.subject,
        active_question=active_q_dict,
        homework_memory={
            "active_status": active_row.status if active_row else "in_progress",
            "previous_student_answers": prev_ans,
            "sheet_solved_question_nos": solved_nos,
            "sheet_pending_questions": pending_list,
        },
        recent_messages=compacted_msgs,
        student_text=student_msg,
        long_term_memory=pedagogical_mem.get("academic"),
        compaction_briefing=briefing,
        pedagogical_memory=pedagogical_mem,
        current_whiteboard=curr_wb,
        teacher_name=tname,
        teacher_gender=teacher_gender or "female",
        student_name=sname,
        student_grade=sgrade,
    )

    # Modelin otonom hafıza aksiyonlarını (set/update/delete) anında kalıcı olarak işle
    if res.get("memory_actions"):
        apply_autonomous_memory_actions(target_user, res["memory_actions"], default_subject=doc.subject)

    q_status = res.get("question_status") or "in_progress"
    step_note = (res.get("student_step_summary") or "").strip()
    target_user = doc.owner_user or frappe.session.user
    if q_status == "solved":
        record_learning_memory(
            target_user,
            doc.subject,
            doc.topic or doc.subject,
            solved_delta=1,
            strength_note=step_note or "Soruyu adım adım doğru çözdü",
        )
    elif q_status == "needs_retry":
        record_learning_memory(
            target_user,
            doc.subject,
            doc.topic or doc.subject,
            mistake_delta=1,
            struggle_note=step_note or f"Takıldığı cevap: {student_msg[:80]}",
        )
    if active_row:
        note = (res.get("student_step_summary") or "").strip()
        entry = f"{student_msg} ({note})" if note else student_msg
        if entry and (not prev_ans or prev_ans[-1] != entry):
            prev_ans.append(entry)
            prev_ans = prev_ans[-12:]
        active_row.student_answers_json = json.dumps(prev_ans, ensure_ascii=False)
        active_row.attempts = int(active_row.attempts or 0) + 1
        active_row.duration_seconds = int(active_row.duration_seconds or 0) + delta_sec
        if q_status in ("in_progress", "solved", "needs_retry"):
            if not (active_row.status == "solved" and q_status == "pending"):
                active_row.status = q_status
        if active_row.status == "solved" and not active_row.completed_at:
            active_row.completed_at = now_datetime()

    if res.get("move_to_next_question") and pending_list:
        nxt_no = pending_list[0]["no"]
        nxt_row = next((r for r in doc.questions if int(r.question_no) == nxt_no), None)
        if nxt_row:
            if nxt_row.status == "pending":
                nxt_row.status = "in_progress"
                nxt_row.started_at = now_datetime()
            doc.active_question_no = nxt_no

    if res.get("whiteboard"):
        merged_wb = apply_whiteboard_action(curr_wb, res["whiteboard"])
        doc.whiteboard_json = json.dumps(merged_wb, ensure_ascii=False)
    doc.tokens_used = int(doc.tokens_used or 0) + tokens
    doc.save(ignore_permissions=True)

    spoken = (res.get("spoken_text") or "").strip()
    emotion = res.get("emotion") or "happy"
    if doc.status == "completed" and prev_sheet_status != "completed":
        mins, secs = divmod(int(doc.duration_seconds or 0), 60)
        dur_txt = f"{mins} dakika {secs} saniyede" if mins > 0 else f"{secs} saniyede"
        spoken += f" Harikasın! Bu ödev sayfasının tamamını {dur_txt} bitirdin! Ödev Zamanı Notun: {doc.time_grade}."
        emotion = "celebrate"

    msgs.append({"role": tname, "text": spoken, "emotion": emotion, "time": now_t})
    doc.messages_json = json.dumps(msgs[-40:], ensure_ascii=False)
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"sheet": _serialize_sheet(doc), "spoken_text": spoken, "emotion": emotion}


@frappe.whitelist()
def tts_audio(text: str, voice: str = "Aoede"):
    _require_login()
    clean = (text or "").strip()[:MAX_TTS_CHARS]
    if not clean:
        frappe.throw("Metin boş.")
    audio_bytes, mime = synthesize_tts(clean, voice=voice or "Aoede")
    return {"audio_b64": base64.b64encode(audio_bytes).decode("ascii"), "mime": mime}


@frappe.whitelist()
def stt_audio(audio_b64: str = "", mime: str = "audio/webm"):
    _require_login()
    if not audio_b64 and frappe.request.files:
        for k in ("file", "audio", "audio_data"):
            if k in frappe.request.files:
                f = frappe.request.files[k]
                audio_bytes = f.read()
                mime = f.content_type or mime
                text = transcribe_audio(audio_bytes, mime_type=mime)
                return {"text": text}
    if audio_b64:
        if "," in audio_b64:
            audio_b64 = audio_b64.split(",", 1)[1]
        audio_bytes = base64.b64decode(audio_b64)
        text = transcribe_audio(audio_bytes, mime_type=mime)
        return {"text": text}
    return {"text": ""}


@frappe.whitelist()
def start_freeform_homework(question_text: str, subject: str = "Matematik", teacher_name: str = "Elif Öğretmen", teacher_gender: str = "female"):
    """Öğrenci kağıt yüklemeden doğrudan soru sorduğunda yeni bir serbest ödev oturumu başlatır."""
    _require_login()
    clean_q = (question_text or "").strip()
    if not clean_q:
        frappe.throw("Soru metni boş olamaz.")
    clean_subj = subject if subject in VALID_SUBJECTS else "Matematik"
    now_t = datetime.now().strftime("%H:%M")
    sname, sgrade = _get_student_name_and_grade(frappe.session.user)

    doc = frappe.get_doc({
        "doctype": "Homework Sheet",
        "title": f"{clean_subj} — {clean_q[:35]}...",
        "owner_user": frappe.session.user,
        "subject": clean_subj,
        "topic": clean_q[:50],
        "started_at": now_datetime(),
        "status": "in_progress",
        "active_question_no": 1,
        "time_score": 100,
        "time_grade": "A+",
        "tokens_used": 0,
        "messages_json": json.dumps([{"role": "Öğrenci", "text": clean_q, "time": now_t}], ensure_ascii=False),
        "whiteboard_json": json.dumps({
            "title": f"{clean_subj} • Soru 1",
            "steps": [f"Soru: {clean_q}"],
            "latex": "",
            "drawing": {"type": "none", "params": {}},
        }, ensure_ascii=False),
        "questions": [
            {
                "question_no": 1,
                "question_text": clean_q,
                "latex": "",
                "status": "in_progress",
                "attempts": 0,
                "duration_seconds": 0,
                "student_answers_json": json.dumps([clean_q], ensure_ascii=False),
            }
        ],
    })
    doc.insert(ignore_permissions=True)

    res, tokens = chat_socratic_turn(
        subject=clean_subj,
        active_question={"question_no": 1, "question_text": clean_q, "latex": ""},
        homework_memory={"active_status": "in_progress", "sheet_solved_question_nos": [], "sheet_pending_questions": []},
        recent_messages=[{"role": "Öğrenci", "text": clean_q}],
        student_text=clean_q,
        teacher_name=teacher_name,
        teacher_gender=teacher_gender,
        student_name=sname,
        student_grade=sgrade,
    )

    spoken = res.get("spoken_text") or f"Sorunu tahtaya aldım! Hadi adım adım birlikte bakalım: {clean_q[:60]}"
    emotion = res.get("emotion") or "happy"

    if res.get("whiteboard") and isinstance(res["whiteboard"], dict):
        wb = apply_whiteboard_action(json.loads(doc.whiteboard_json), res["whiteboard"])
        doc.whiteboard_json = json.dumps(wb, ensure_ascii=False)

    msgs = json.loads(doc.messages_json)
    msgs.append({"role": teacher_name, "text": spoken, "emotion": emotion, "time": now_t})
    doc.messages_json = json.dumps(msgs, ensure_ascii=False)
    doc.tokens_used = tokens
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"sheet": _serialize_sheet(doc), "spoken_text": spoken, "emotion": emotion}


@frappe.whitelist()
def delete_sheet(sheet_id: str):
    """Ödev sayfasını ve ilişkili soruları veritabanından siler."""
    _require_login()
    if not frappe.db.exists("Homework Sheet", sheet_id):
        return {"success": False, "message": "Ödev sayfası bulunamadı."}
    doc = frappe.get_doc("Homework Sheet", sheet_id)
    if doc.owner_user != frappe.session.user and "System Manager" not in frappe.get_roles():
        frappe.throw("Bu ödevi silme yetkiniz yok.", frappe.PermissionError)
    frappe.delete_doc("Homework Sheet", sheet_id, force=1)
    frappe.db.commit()
    return {"success": True, "sheet_id": sheet_id}


