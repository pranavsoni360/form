"""
Verify the SIP trunk configuration on your LiveKit instance.

Shows every outbound + inbound trunk + dispatch rule that LiveKit knows
about, groups them by best-guess provider (Viva / Twilio / unknown),
highlights which trunk matches your env `SIP_TRUNK_ID`, and warns about
common misconfigurations (e.g. the env var points to an INBOUND-only
trunk, which would break outbound dispatch).

Usage
=====
    cd agent
    python verify_trunk.py
"""

import asyncio
import os
import sys

from dotenv import load_dotenv
from livekit import api

load_dotenv(".env.local")

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://164.52.217.236:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "").strip()
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "").strip()
SIP_TRUNK_ID = os.getenv("SIP_TRUNK_ID", "").strip()  # backend's outbound fallback
TWILIO_NUMBER = os.getenv("TWILIO_NUMBER", "").strip()


# ─── Helpers ────────────────────────────────────────────────────────────────

async def _list_with_fallback(client, names, request):
    """SDK method names changed between versions — try newer then older."""
    for n in names:
        if hasattr(client, n):
            return await getattr(client, n)(request)
    raise RuntimeError(f"None of {names} found on lk.sip")


def _guess_provider(trunk) -> str:
    """Best-effort provider tag based on FriendlyName + address + number prefix."""
    name = (getattr(trunk, "name", "") or "").lower()
    address = (getattr(trunk, "address", "") or "").lower()
    numbers = getattr(trunk, "numbers", None) or []
    if "twilio" in name or "pstn.twilio.com" in address:
        return "twilio"
    if "viva" in name or "vivphone" in address or "vivap" in address:
        return "viva"
    if any(n.startswith("+91") for n in numbers):
        return "india (guess)"
    if any(n.startswith("+1") for n in numbers):
        return "us/canada (guess)"
    return "?"


def _print_trunk(trunk, role: str, configured_id: str) -> None:
    is_match = trunk.sip_trunk_id == configured_id
    marker = "✅ CONFIGURED" if is_match else "    "
    provider = _guess_provider(trunk)
    print(f"{marker}  [{role}] {trunk.sip_trunk_id}   provider: {provider}")
    print(f"          name:    {getattr(trunk, 'name', '') or '(unnamed)'}")
    if role == "OUTBOUND":
        print(f"          address: {getattr(trunk, 'address', '') or '(none)'}")
        print(f"          transport: {getattr(trunk, 'transport', '?')}")
    print(f"          numbers: {list(getattr(trunk, 'numbers', None) or []) or '(none)'}")
    if getattr(trunk, "auth_username", ""):
        print(f"          auth_user: {trunk.auth_username}")
    print()


# ─── Main ───────────────────────────────────────────────────────────────────

async def main():
    print("=" * 70)
    print("🔍 LiveKit SIP trunk verification")
    print("=" * 70)
    print(f"   LiveKit URL:          {LIVEKIT_URL}")
    print(f"   API key:              {LIVEKIT_API_KEY[:8]}... (truncated)")
    print(f"   Configured trunk env: {SIP_TRUNK_ID or '(unset — backend uses phone_numbers DB row)'}")

    lk = api.LiveKitAPI(
        url=LIVEKIT_URL,
        api_key=LIVEKIT_API_KEY,
        api_secret=LIVEKIT_API_SECRET,
    )

    try:
        # ── Outbound ─────────────────────────────────────────────────────
        out = await _list_with_fallback(
            lk.sip,
            ("list_outbound_trunk", "list_sip_outbound_trunk"),
            api.ListSIPOutboundTrunkRequest(),
        )
        outbound_items = list(out.items or [])

        print()
        print("=" * 70)
        print(f"📤 OUTBOUND trunks  ({len(outbound_items)} total)")
        print("=" * 70)
        if not outbound_items:
            print("   ❌ No outbound trunks — dispatcher can't place calls!")
        else:
            for t in outbound_items:
                _print_trunk(t, "OUTBOUND", SIP_TRUNK_ID)

        # ── Inbound ──────────────────────────────────────────────────────
        ins = await _list_with_fallback(
            lk.sip,
            ("list_inbound_trunk", "list_sip_inbound_trunk"),
            api.ListSIPInboundTrunkRequest(),
        )
        inbound_items = list(ins.items or [])

        print("=" * 70)
        print(f"📥 INBOUND trunks  ({len(inbound_items)} total)")
        print("=" * 70)
        if not inbound_items:
            print("   ⚠️  No inbound trunks — customers can't dial in (OK if outbound-only).")
        else:
            for t in inbound_items:
                _print_trunk(t, "INBOUND", SIP_TRUNK_ID)

        # ── Dispatch rules ───────────────────────────────────────────────
        rules = await _list_with_fallback(
            lk.sip,
            ("list_dispatch_rule", "list_sip_dispatch_rule"),
            api.ListSIPDispatchRuleRequest(),
        )
        rule_items = list(rules.items or [])

        print("=" * 70)
        print(f"📋 DISPATCH rules  ({len(rule_items)} total)")
        print("=" * 70)
        if not rule_items:
            print("   ⚠️  No dispatch rules — inbound calls won't route to rooms.")
        else:
            for r in rule_items:
                print(f"   {r.sip_dispatch_rule_id}   "
                      f"name: {getattr(r, 'name', '') or '(unnamed)'}")
                print(f"       trunk_ids: {list(getattr(r, 'trunk_ids', None) or [])}")
                print()

        # ── Diagnostics ──────────────────────────────────────────────────
        print("=" * 70)
        print("🩺 Diagnostics")
        print("=" * 70)

        out_ids = {t.sip_trunk_id for t in outbound_items}
        in_ids = {t.sip_trunk_id for t in inbound_items}

        if SIP_TRUNK_ID:
            if SIP_TRUNK_ID in out_ids:
                print(f"  ✅ env SIP_TRUNK_ID is a valid OUTBOUND trunk")
            elif SIP_TRUNK_ID in in_ids:
                print(f"  ❌ env SIP_TRUNK_ID points to an INBOUND trunk — dispatcher will 404")
                print(f"     Pick one of the outbound trunks above and update backend/.env")
            else:
                print(f"  ❌ env SIP_TRUNK_ID ({SIP_TRUNK_ID}) doesn't match ANY trunk")
                print(f"     Either re-run create_*_trunk.py, or update backend/.env")
        else:
            print(f"  ℹ️  SIP_TRUNK_ID unset — backend will pick per-number trunk from "
                  f"phone_numbers table. Make sure each row has a valid livekit_trunk_id.")

        # If Twilio number is configured, check it has a covering outbound trunk
        if TWILIO_NUMBER:
            tw_covered = [
                t for t in outbound_items
                if TWILIO_NUMBER in (getattr(t, "numbers", None) or [])
            ]
            if tw_covered:
                print(f"  ✅ Twilio number {TWILIO_NUMBER} has outbound trunk: "
                      f"{tw_covered[0].sip_trunk_id}")
            else:
                print(f"  ⚠️  Twilio number {TWILIO_NUMBER} not on any outbound trunk. "
                      f"Run create_twilio_trunk.py")

        # Provider tally
        providers = {}
        for t in outbound_items:
            p = _guess_provider(t)
            providers[p] = providers.get(p, 0) + 1
        if providers:
            print("\n  Provider tally (outbound):")
            for p, n in sorted(providers.items()):
                print(f"    {p:20s} {n}")

        print()

    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        print(f"\nTroubleshooting:")
        print(f"  1. LiveKit reachable?  curl {LIVEKIT_URL.replace('ws://', 'http://').replace('wss://', 'https://')}/")
        print(f"  2. API credentials in agent/.env.local correct?")
        print(f"  3. From the GPU box: docker logs livekit-server --tail 50")
        sys.exit(1)
    finally:
        await lk.aclose()


if __name__ == "__main__":
    asyncio.run(main())
