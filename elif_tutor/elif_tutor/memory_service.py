from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List

import frappe
from frappe.utils import now_datetime


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9çğıöşü]+", " ", (text or "").lower())).strip()


def _append_bullet(existing: str, note: str, max_items: int = 5) -> str:
    note = (note or "").strip()
    if not note:
        return existing or ""
    lines = [ln.strip() for ln in (existing or "").splitlines() if ln.strip()]
    clean_note = note[:140]
    if any(_norm(clean_note) == _norm(ln.lstrip("-• ")) for ln in lines):
        return "\n".join(lines[-max_items:])
    lines.append(f"- {clean_note}")
    return "\n".join(lines[-max_items:])


def _sync_markdown_journal(user: str) -> None:
    """Kullanıcının uzun dönem öğrenme hafızasını okunabilir Markdown dosyası olarak da güncel tutar."""
    try:
        rows = frappe.get_all(
            "Student Learning Memory",
            filters={"owner_user": user},
            fields=["subject", "topic", "mastery_status", "solved_count", "mistake_count", "struggle_notes", "strength_notes", "last_practiced"],
            order_by="last_practiced desc",
            limit=40,
        )
        safe_user = re.sub(r"[^a-zA-Z0-9_.-]+", "_", user)
        out_path = Path(frappe.get_site_path("private", "files", f"learning_memory_{safe_user}.md"))
        out_path.parent.mkdir(parents=True, exist_ok=True)
        md_lines = [f"# Uzun Dönem Öğrenme Hafızası ({user})", ""]
        for r in rows:
            md_lines.append(f"## {r.subject} — {r.topic} ({r.mastery_status})")
            md_lines.append(f"- Doğru: {r.solved_count} | Takılma: {r.mistake_count} | Son Çalışma: {r.last_practiced}")
            if r.struggle_notes:
                md_lines.append("### Takıldığı Noktalar")
                md_lines.append(r.struggle_notes)
            if r.strength_notes:
                md_lines.append("### Güçlü Noktalar")
                md_lines.append(r.strength_notes)
            md_lines.append("")
        out_path.write_text("\n".join(md_lines), encoding="utf-8")
    except Exception:
        pass


def record_learning_memory(
    user: str,
    subject: str,
    topic: str,
    solved_delta: int = 0,
    mistake_delta: int = 0,
    struggle_note: str = "",
    strength_note: str = "",
) -> None:
    """Ders/konu bazlı uzun dönem öğrenme özetini günceller (cross-session hafıza)."""
    topic = (topic or subject or "").strip()[:80]
    if not topic or not user or user == "Guest":
        return

    existing = frappe.db.get_value(
        "Student Learning Memory",
        {"owner_user": user, "subject": subject, "topic": topic},
        "name",
    )
    if existing:
        doc = frappe.get_doc("Student Learning Memory", existing)
    else:
        doc = frappe.get_doc({
            "doctype": "Student Learning Memory",
            "owner_user": user,
            "subject": subject,
            "topic": topic,
            "solved_count": 0,
            "mistake_count": 0,
            "struggle_notes": "",
            "strength_notes": "",
        })

    doc.solved_count = int(doc.solved_count or 0) + max(0, int(solved_delta))
    doc.mistake_count = int(doc.mistake_count or 0) + max(0, int(mistake_delta))
    if struggle_note:
        doc.struggle_notes = _append_bullet(doc.struggle_notes, struggle_note)
    if strength_note:
        doc.strength_notes = _append_bullet(doc.strength_notes, strength_note)
    doc.last_practiced = now_datetime()

    if existing:
        doc.save(ignore_permissions=True)
    else:
        doc.insert(ignore_permissions=True)
    _sync_markdown_journal(user)


def get_relevant_long_term_memory(user: str, subject: str, topic: str = "", query_text: str = "", limit: int = 2) -> List[Dict[str, Any]]:
    """
    SADECE İHTİYAÇ DUYULDUĞUNDA (On-Demand):
    Tüm geçmişi modele yüklemek yerine, yalnızca mevcut ders ve konuya en alakalı
    en fazla 2 eski öğrenme özetini döndürür (minimum token!).
    """
    if not user or user == "Guest":
        return []
    rows = frappe.get_all(
        "Student Learning Memory",
        filters={"owner_user": user, "subject": subject},
        fields=["subject", "topic", "mastery_status", "solved_count", "mistake_count", "struggle_notes", "strength_notes", "last_practiced"],
        order_by="last_practiced desc",
        limit=25,
    )
    if not rows:
        return []

    q_words = set(_norm(f"{topic} {query_text}").split())
    scored = []
    for r in rows:
        t_words = set(_norm(f"{r.topic} {r.struggle_notes or ''}").split())
        overlap = len(q_words & t_words)
        exact = 3 if topic and _norm(topic) == _norm(r.topic) else 0
        # Alakalı konu yoksa veya sadece aynı dersten en son 'needs_review' varsa düşük ağırlıkla değerlendir
        score = exact + overlap + (0.5 if r.mastery_status == "needs_review" else 0)
        if score >= 1 or (not topic and r.mastery_status == "needs_review"):
            scored.append((score, r))

    scored.sort(key=lambda x: x[0], reverse=True)
    result = []
    for _, r in scored[:limit]:
        result.append({
            "konu": r.topic,
            "durum": r.mastery_status,
            "dogru": int(r.solved_count or 0),
            "takilma": int(r.mistake_count or 0),
            "onceki_takildigi_noktalar": (r.struggle_notes or "").strip(),
            "guclu_noktalar": (r.strength_notes or "").strip(),
        })
    return result


def list_learning_memories(user: str, limit: int = 30) -> List[Dict[str, Any]]:
    if not user or user == "Guest":
        return []
    rows = frappe.get_all(
        "Student Learning Memory",
        filters={"owner_user": user},
        fields=["subject", "topic", "mastery_status", "solved_count", "mistake_count", "struggle_notes", "strength_notes", "last_practiced"],
        order_by="last_practiced desc",
        limit=limit,
    )
    return [
        {
            "subject": r.subject,
            "topic": r.topic,
            "mastery_status": r.mastery_status,
            "solved_count": int(r.solved_count or 0),
            "mistake_count": int(r.mistake_count or 0),
            "struggle_notes": r.struggle_notes or "",
            "strength_notes": r.strength_notes or "",
            "last_practiced": str(r.last_practiced or ""),
        }
        for r in rows
    ]
