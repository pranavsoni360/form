"""Transactional email — SMTP, config-gated, non-fatal.

Wired for the bank-admin user invites (design_handoff_finix Job 1). Reads SMTP
settings from the environment; if they are absent the sender degrades
gracefully: it logs and returns ``sent=False`` instead of raising, so the invite
row is still created and the UI can fall back to showing the copyable link.
That means QA works without an SMTP account, and email becomes live the moment
the env vars are set — no code change.

Env:
    SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASSWORD,
    SMTP_FROM (default SMTP_USER), SMTP_STARTTLS ("1"/"0", default 1),
    APP_PUBLIC_URL (base for invite links, e.g. https://finix.vgipl.com).
"""
from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage

logger = logging.getLogger("mailer")


def smtp_configured() -> bool:
    return bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"))


def public_base_url() -> str:
    return (os.getenv("APP_PUBLIC_URL") or "https://finix.vgipl.com").rstrip("/")


def send_email(to: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
    """Send one email. Returns True on success, False if SMTP is unconfigured or
    the send fails (never raises — email is best-effort for invites)."""
    if not smtp_configured():
        logger.warning("SMTP not configured; skipping email to %s (subject=%r)", to, subject)
        return False

    host = os.getenv("SMTP_HOST", "")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "")
    password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM") or user
    starttls = os.getenv("SMTP_STARTTLS", "1") != "0"

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text_body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    try:
        if port == 465:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=15) as s:
                s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                if starttls:
                    s.starttls(context=ssl.create_default_context())
                s.login(user, password)
                s.send_message(msg)
        logger.info("Sent email to %s (subject=%r)", to, subject)
        return True
    except Exception:
        logger.exception("Failed to send email to %s", to)
        return False


def send_invite_email(to: str, full_name: str, bank_name: str, invite_url: str, expires_human: str) -> bool:
    """Compose + send a bank-user invite. Sentence-case copy per the design."""
    subject = f"You have been invited to {bank_name} on Finix"
    text = (
        f"Hello {full_name},\n\n"
        f"{bank_name} has invited you to Finix, its loan origination workspace.\n\n"
        f"Accept your invite and set a password:\n{invite_url}\n\n"
        f"This link expires on {expires_human}.\n\n"
        f"If you were not expecting this, you can ignore this email.\n"
    )
    html = (
        f"<p>Hello {full_name},</p>"
        f"<p>{bank_name} has invited you to Finix, its loan origination workspace.</p>"
        f'<p><a href="{invite_url}">Accept your invite and set a password</a></p>'
        f"<p style=\"color:#666\">This link expires on {expires_human}. "
        f"If you were not expecting this, you can ignore this email.</p>"
    )
    return send_email(to, subject, text, html)
