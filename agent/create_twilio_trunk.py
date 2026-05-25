"""
Create a Twilio Elastic SIP Trunk + matching LiveKit outbound/inbound trunks
for international calling. Non-destructive — won't touch existing Viva (India)
or any other trunk on LiveKit.

What it does
============
  Twilio side (via REST API):
    1. Look up your phone number SID on the account.
    2. Find-or-create a Credential List with a random SIP username/password.
    3. Find-or-create an Elastic Trunk (FriendlyName = VirtualVaani Twilio).
    4. Associate the Credential List + phone number with the Trunk.

  LiveKit side (via SDK):
    5. Create an OUTBOUND trunk pointing at Twilio's termination URI
       (so we can dial out from +17744930587 etc).
    6. Create an INBOUND trunk on the same number (so customers can call us).
    7. Create a dispatch rule for the inbound trunk.

Setup
=====
Add these to `agent/.env.local` (gitignored — never commit):

    # ── Twilio (US / international) ─────────────────────────
    TWILIO_ACCOUNT_SID=AC...........................
    TWILIO_AUTH_TOKEN=................................
    TWILIO_NUMBER=+1XXXXXXXXXX

    # ── LiveKit (already there) ─────────────────────────────
    LIVEKIT_URL=ws://164.52.217.236:7880
    LIVEKIT_API_KEY=...
    LIVEKIT_API_SECRET=...

    # ── Optional — set ONLY if re-running and you already saved the password
    # the first run printed. Leave unset on first run.
    TWILIO_SIP_USER=vaani-out
    TWILIO_SIP_PASS=...

Run
===
    cd agent
    python create_twilio_trunk.py

The script is **idempotent**: safe to re-run. It only creates resources that
don't already exist (matched by FriendlyName / phone number).

After running, copy the printed `Outbound trunk ID` into your DB:

    INSERT INTO phone_numbers (pool_id, phone_number, livekit_trunk_id, status)
    VALUES (
      (SELECT id FROM phone_pools WHERE name = 'pusad-default' LIMIT 1),
      '+17744930587',
      '<paste outbound trunk id here>',
      'active'
    );
"""

import asyncio
import os
import secrets
import string
import sys
from urllib.parse import quote

import requests
from dotenv import load_dotenv
from livekit import api
from livekit.protocol import sip

load_dotenv(".env.local")

# ─── Config ─────────────────────────────────────────────────────────────────

TWILIO_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_NUMBER = os.getenv("TWILIO_NUMBER", "").strip()  # E.164, e.g. +17744930587

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://164.52.217.236:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "").strip()
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "").strip()

# Cosmetic names used to find existing resources on re-runs
TRUNK_FRIENDLY_NAME = "VirtualVaani Twilio Outbound"
CREDENTIAL_LIST_NAME = "VirtualVaani SIP Credentials"
SIP_USERNAME_DEFAULT = "vaani-out"  # random password is auto-generated

# Twilio API roots
TWILIO_API = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}"
TWILIO_TRUNKING = "https://trunking.twilio.com/v1"
TWILIO_AUTH = (TWILIO_SID, TWILIO_TOKEN)
TWILIO_TIMEOUT = 30


# ─── Tiny helpers ───────────────────────────────────────────────────────────

def must_env(name: str, value: str) -> None:
    if not value:
        print(f"❌ Missing required env var: {name}", file=sys.stderr)
        print(f"   Add it to agent/.env.local and re-run.", file=sys.stderr)
        sys.exit(1)


def gen_password(length: int = 20) -> str:
    """Twilio rejects some special chars in SIP passwords; stick to alphanumerics."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def t_get(path: str) -> dict:
    r = requests.get(path, auth=TWILIO_AUTH, timeout=TWILIO_TIMEOUT)
    r.raise_for_status()
    return r.json()


def t_post(path: str, data: dict) -> dict:
    r = requests.post(path, auth=TWILIO_AUTH, data=data, timeout=TWILIO_TIMEOUT)
    if r.status_code >= 400 and r.status_code != 409:
        print(f"   ❌ Twilio API {r.status_code}: {r.text}")
        r.raise_for_status()
    return r.json() if r.text else {}


# ─── Twilio provisioning ────────────────────────────────────────────────────

def find_phone_number_sid() -> str:
    """Look up the SID of TWILIO_NUMBER on the account. Errors if not found."""
    print(f"\n🔍 Looking up phone {TWILIO_NUMBER} on Twilio account ...")
    data = t_get(f"{TWILIO_API}/IncomingPhoneNumbers.json?PhoneNumber={quote(TWILIO_NUMBER)}")
    nums = data.get("incoming_phone_numbers", [])
    if not nums:
        raise RuntimeError(
            f"Phone {TWILIO_NUMBER} is not on this Twilio account. "
            f"Buy / port it via the Twilio console first."
        )
    pn = nums[0]
    print(f"   ✅ Found {TWILIO_NUMBER}  (SID: {pn['sid']})")
    return pn["sid"]


def find_or_create_credential_list() -> tuple:
    """Find existing CL by name, or create new one + add credential.

    Returns (cl_sid, sip_username, sip_password). On reuse, password is None
    (Twilio won't return the password ever again after creation)."""
    print(f"\n🔐 Looking up credential list '{CREDENTIAL_LIST_NAME}' ...")
    data = t_get(f"{TWILIO_API}/SIP/CredentialLists.json")
    for cl in data.get("credential_lists", []):
        if cl["friendly_name"] == CREDENTIAL_LIST_NAME:
            print(f"   ♻️  Reusing existing CL (SID: {cl['sid']})")
            print(f"      ⚠️  Twilio doesn't expose the saved password again. "
                  f"If you didn't save it the first time, see Re-running below.")
            return cl["sid"], None, None

    print("   ➕ Creating new credential list ...")
    cl = t_post(
        f"{TWILIO_API}/SIP/CredentialLists.json",
        {"FriendlyName": CREDENTIAL_LIST_NAME},
    )
    sip_user = SIP_USERNAME_DEFAULT
    sip_pass = gen_password()
    print(f"   ✅ CL created (SID: {cl['sid']})")
    print(f"   ➕ Adding credential username={sip_user} ...")
    t_post(
        f"{TWILIO_API}/SIP/CredentialLists/{cl['sid']}/Credentials.json",
        {"Username": sip_user, "Password": sip_pass},
    )
    print(f"   ✅ Credential added")
    return cl["sid"], sip_user, sip_pass


def find_or_create_trunk(phone_sid: str, cl_sid: str) -> tuple:
    """Find existing Twilio Trunk by FriendlyName, or create one.

    Then attach the credential list + phone number. Both attachments are
    idempotent — Twilio returns 409 on re-attach, which we treat as success.

    Returns (trunk_sid, termination_uri_domain)."""
    print(f"\n📞 Looking up trunk '{TRUNK_FRIENDLY_NAME}' ...")
    data = t_get(f"{TWILIO_TRUNKING}/Trunks")
    existing = next(
        (tk for tk in data.get("trunks", []) if tk["friendly_name"] == TRUNK_FRIENDLY_NAME),
        None,
    )
    if existing:
        trunk_sid = existing["sid"]
        domain = existing["domain_name"]
        print(f"   ♻️  Reusing trunk (SID: {trunk_sid}, URI: {domain})")
    else:
        print("   ➕ Creating new elastic trunk ...")
        tk = t_post(
            f"{TWILIO_TRUNKING}/Trunks",
            {"FriendlyName": TRUNK_FRIENDLY_NAME, "Secure": "false"},
        )
        trunk_sid = tk["sid"]
        domain = tk["domain_name"]
        print(f"   ✅ Trunk created (SID: {trunk_sid})")
        print(f"      Termination URI: {domain}")

    # Attach credential list (Twilio dedups — 409 is fine)
    print(f"   🔗 Attaching credential list {cl_sid} ...")
    r = requests.post(
        f"{TWILIO_TRUNKING}/Trunks/{trunk_sid}/CredentialLists",
        auth=TWILIO_AUTH,
        data={"CredentialListSid": cl_sid},
        timeout=TWILIO_TIMEOUT,
    )
    print(f"      → {r.status_code} ({'attached' if r.status_code < 400 else 'already attached'})")

    # Attach phone number
    print(f"   🔗 Attaching phone {TWILIO_NUMBER} (PN SID {phone_sid}) ...")
    r = requests.post(
        f"{TWILIO_TRUNKING}/Trunks/{trunk_sid}/PhoneNumbers",
        auth=TWILIO_AUTH,
        data={"PhoneNumberSid": phone_sid},
        timeout=TWILIO_TIMEOUT,
    )
    print(f"      → {r.status_code} ({'attached' if r.status_code < 400 else 'already attached'})")

    return trunk_sid, domain


# ─── LiveKit side ───────────────────────────────────────────────────────────

async def _list_with_fallback(client, names: tuple, request) -> list:
    """SDK method names changed between versions — try newer then older."""
    for n in names:
        if hasattr(client, n):
            return await getattr(client, n)(request)
    raise RuntimeError(f"None of {names} found on lk.sip")


async def create_livekit_trunks(termination_domain: str, sip_user: str, sip_pass: str) -> tuple:
    """Provision LiveKit-side outbound + inbound + dispatch rule for Twilio."""
    lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
    try:
        # ── Outbound ─────────────────────────────────────────────────────
        out_list = await _list_with_fallback(
            lk.sip,
            ("list_outbound_trunk", "list_sip_outbound_trunk"),
            api.ListSIPOutboundTrunkRequest(),
        )
        existing_out = next(
            (t for t in (out_list.items or [])
             if TWILIO_NUMBER in (getattr(t, "numbers", None) or [])),
            None,
        )
        if existing_out:
            print(f"\n✅ LiveKit OUTBOUND already exists for {TWILIO_NUMBER}: {existing_out.sip_trunk_id}")
            out_sid = existing_out.sip_trunk_id
        else:
            print(f"\n📤 Creating LiveKit OUTBOUND → {termination_domain} ...")
            req = api.CreateSIPOutboundTrunkRequest(
                trunk=sip.SIPOutboundTrunkInfo(
                    name="Twilio Outbound (US)",
                    address=termination_domain,
                    # TCP is what Twilio recommends for elastic trunks. Flip
                    # to TLS later if you enable Secure=true on the Twilio side.
                    transport=sip.SIPTransport.SIP_TRANSPORT_TCP,
                    numbers=[TWILIO_NUMBER],
                    auth_username=sip_user,
                    auth_password=sip_pass,
                )
            )
            resp = await lk.sip.create_sip_outbound_trunk(req)
            out_sid = resp.sip_trunk_id
            print(f"   ✅ Outbound created: {out_sid}")

        # ── Inbound ──────────────────────────────────────────────────────
        in_list = await _list_with_fallback(
            lk.sip,
            ("list_inbound_trunk", "list_sip_inbound_trunk"),
            api.ListSIPInboundTrunkRequest(),
        )
        existing_in = next(
            (t for t in (in_list.items or [])
             if TWILIO_NUMBER in (getattr(t, "numbers", None) or [])),
            None,
        )
        if existing_in:
            print(f"✅ LiveKit INBOUND already exists for {TWILIO_NUMBER}: {existing_in.sip_trunk_id}")
            in_sid = existing_in.sip_trunk_id
        else:
            print(f"\n📥 Creating LiveKit INBOUND for {TWILIO_NUMBER} ...")
            req = api.CreateSIPInboundTrunkRequest(
                trunk=sip.SIPInboundTrunkInfo(
                    name="Twilio Inbound (US)",
                    numbers=[TWILIO_NUMBER],
                    auth_username=sip_user,
                    auth_password=sip_pass,
                    krisp_enabled=False,
                )
            )
            resp = await lk.sip.create_sip_inbound_trunk(req)
            in_sid = resp.sip_trunk_id
            print(f"   ✅ Inbound created: {in_sid}")

        # ── Dispatch rule ────────────────────────────────────────────────
        rules = await _list_with_fallback(
            lk.sip,
            ("list_dispatch_rule", "list_sip_dispatch_rule"),
            api.ListSIPDispatchRuleRequest(),
        )
        rule_covers = any(
            in_sid in (getattr(r, "trunk_ids", None) or [])
            for r in (rules.items or [])
        )
        if rule_covers:
            print(f"✅ Dispatch rule already covers inbound trunk {in_sid}")
        else:
            print(f"➕ Creating dispatch rule for inbound {in_sid} ...")
            req = api.CreateSIPDispatchRuleRequest(
                rule=sip.SIPDispatchRule(
                    dispatch_rule_direct=sip.SIPDispatchRuleDirect(room_name="call-", pin="")
                ),
                trunk_ids=[in_sid],
                hide_phone_number=False,
                name="Twilio Auto Dispatch",
            )
            resp = await lk.sip.create_sip_dispatch_rule(req)
            print(f"   ✅ Dispatch rule created: {resp.sip_dispatch_rule_id}")

        return out_sid, in_sid

    finally:
        await lk.aclose()


# ─── Main ───────────────────────────────────────────────────────────────────

async def main():
    print("=" * 70)
    print("➕ Twilio Elastic SIP Trunk + LiveKit wire-up (non-destructive)")
    print("=" * 70)
    print(f"   LiveKit:        {LIVEKIT_URL}")
    print(f"   Twilio account: {TWILIO_SID[:8]}...")
    print(f"   Twilio number:  {TWILIO_NUMBER}")

    must_env("TWILIO_ACCOUNT_SID", TWILIO_SID)
    must_env("TWILIO_AUTH_TOKEN", TWILIO_TOKEN)
    must_env("TWILIO_NUMBER", TWILIO_NUMBER)
    must_env("LIVEKIT_API_KEY", LIVEKIT_API_KEY)
    must_env("LIVEKIT_API_SECRET", LIVEKIT_API_SECRET)

    # ── Twilio side ──────────────────────────────────────────────────────
    phone_sid = find_phone_number_sid()
    cl_sid, sip_user, sip_pass = find_or_create_credential_list()

    # If we reused an existing CL, Twilio won't give us the password. The user
    # either saved it the first run (set TWILIO_SIP_USER/PASS in env), or
    # they need to nuke the CL and re-run.
    if sip_user is None:
        sip_user = os.getenv("TWILIO_SIP_USER", "").strip() or SIP_USERNAME_DEFAULT
        sip_pass = os.getenv("TWILIO_SIP_PASS", "").strip()
        if not sip_pass:
            print()
            print("⚠️  Reusing existing credential list — but the password can't be")
            print("   recovered from Twilio. Either:")
            print("     a) Delete the CredentialList in Twilio console → re-run this script")
            print("        (it will auto-generate fresh credentials), OR")
            print("     b) If you saved the password from the first run, add to")
            print("        agent/.env.local: TWILIO_SIP_USER=... and TWILIO_SIP_PASS=...")
            print("        and re-run.")
            sys.exit(1)

    trunk_sid, termination_domain = find_or_create_trunk(phone_sid, cl_sid)

    # ── LiveKit side ─────────────────────────────────────────────────────
    lk_out_sid, lk_in_sid = await create_livekit_trunks(termination_domain, sip_user, sip_pass)

    # ── Summary ──────────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("🎯 SUMMARY — save these")
    print("=" * 70)
    print(f"\n  Twilio side")
    print(f"    Phone:               {TWILIO_NUMBER}")
    print(f"    Trunk SID:           {trunk_sid}")
    print(f"    Termination URI:     {termination_domain}")
    print(f"    Credential List SID: {cl_sid}")
    if sip_pass and os.getenv("TWILIO_SIP_PASS") != sip_pass:
        print(f"    SIP user:            {sip_user}")
        print(f"    SIP pass:            {sip_pass}")
        print()
        print(f"  ⚠️ SAVE PASSWORD NOW. Twilio won't show it again. Add to agent/.env.local:")
        print(f"      TWILIO_SIP_USER={sip_user}")
        print(f"      TWILIO_SIP_PASS={sip_pass}")

    print(f"\n  LiveKit side")
    print(f"    Outbound trunk ID:   {lk_out_sid}")
    print(f"    Inbound trunk ID:    {lk_in_sid}")

    print(f"\n  Next — register the number in your dispatcher pool:")
    print(f"  ───────────────────────────────────────────────────")
    print(f"  docker exec -i los-postgres-dev psql -U los_admin -d los_form -c \"")
    print(f"    INSERT INTO phone_numbers (pool_id, phone_number, livekit_trunk_id, status)")
    print(f"    VALUES (")
    print(f"      (SELECT id FROM phone_pools WHERE name = 'pusad-default' LIMIT 1),")
    print(f"      '{TWILIO_NUMBER}',")
    print(f"      '{lk_out_sid}',")
    print(f"      'active'")
    print(f"    ) ON CONFLICT (pool_id, phone_number) DO UPDATE")
    print(f"      SET livekit_trunk_id = EXCLUDED.livekit_trunk_id,")
    print(f"          status = 'active';\"")
    print()
    print("✅ Done. Existing Viva (India) trunks untouched.")
    print("=" * 70)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        import traceback
        print("\n❌ FAILED:")
        traceback.print_exc()
        sys.exit(1)
